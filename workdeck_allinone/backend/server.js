
import express from 'express';
import path from 'path';
import fs from 'fs';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import multer from 'multer';
import mime from 'mime-types';

import inferStub from './src/inference/stub.js';
import transcribeMedia from './src/inference/transcribe.js';
import { extractFieldsFromTranscript } from './src/inference/extract-estimate.js';
import { loadPrecision, savePrecision, update as precUpdate, tighten as precTighten } from './src/model/precision.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ORIGIN_ALLOWLIST = (process.env.ORIGIN_ALLOWLIST || '').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '20', 10);
const ALLOWED_MIME = (process.env.ALLOWED_MIME || 'image/jpeg,image/png,image/webp,video/mp4,audio/mpeg').split(',').map(s=>s.trim());
const PAYWALL_DISABLED = (process.env.PAYWALL_DISABLED || 'true').toLowerCase() === 'true';
const DEV_TRAINING = (process.env.DEV_TRAINING || '1') === '1';

// precision model
let PREC = loadPrecision(DATA_DIR);

// ensure data dirs
for (const d of ['uploads','devices','analytics','logs']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}

// logging
let accessStream = fs.createWriteStream(path.join(DATA_DIR,'logs','app.log'), { flags: 'a' });
app.use(morgan('combined', { stream: accessStream }));

// security, parsers
app.use(helmet({ contentSecurityPolicy: false }));
if (ORIGIN_ALLOWLIST.length) {
  app.use(cors({
    origin: (origin, cb) => (!origin || ORIGIN_ALLOWLIST.includes(origin)) ? cb(null, true) : cb(new Error('CORS')),
    credentials: true
  }));
} else {
  app.use(cors({ origin: true, credentials: true }));
}
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// device cookie
const COOKIE = 'wa_device';
app.use((req, res, next) => {
  let device = req.cookies[COOKIE];
  if (!device) {
    device = 'd_' + uuidv4();
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE, device, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000*60*60*24*365*5 });
  }
  req.deviceId = device;
  next();
});

// static
app.use('/uploads', express.static(path.join(DATA_DIR, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// helpers
function isWritableDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}
function readJSON(file, fb) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return fb; } }
function writeJSON(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
const eventsPath = path.join(DATA_DIR, 'analytics', 'events.ndjson');
const estimatesPath = path.join(DATA_DIR, 'analytics', 'estimates.ndjson');
function logEvent(name, props={}, req=null) {
  const row = { ts: new Date().toISOString(), name, deviceId: req?.deviceId || null, props };
  fs.appendFileSync(eventsPath, JSON.stringify(row) + '\n');
}
function logEstimate(row) {
  fs.appendFileSync(estimatesPath, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

// rate limit (soft)
const hits = new Map(); const WINDOW=60000, MAX=150;
function rl(ip){
  const now = Date.now();
  const rec = hits.get(ip) || {c:0, t:now};
  if (now - rec.t > WINDOW) { rec.c=0; rec.t=now; }
  rec.c++; hits.set(ip, rec);
  return rec.c <= MAX;
}

// storage
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB*1024*1024 } });
function writeUpload(buffer, deviceId, id, mimetype) {
  const ext = mime.extension(mimetype) || 'bin';
  const dir = path.join(DATA_DIR, 'uploads', deviceId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, `${id}.${ext}`);
  fs.writeFileSync(abs, buffer);
  return { abs, url: `/uploads/${deviceId}/${id}.${ext}`, ext };
}

// inference selector (stub only for now)
async function inferFromImage(absPath, opts={}) {
  return inferStub(absPath, opts);
}

// health
app.get('/healthz', (req,res)=> res.status(200).json({ ok:true }));
app.get('/readyz', (req,res)=> res.status(isWritableDir(DATA_DIR)?200:503).json({ dataDir: DATA_DIR, writable: isWritableDir(DATA_DIR) }));

// list cards
function deviceCardsPath(deviceId){ return path.join(DATA_DIR, 'devices', deviceId, 'cards.json'); }
app.get('/api/jobs/list', (req,res)=> {
  const cards = readJSON(deviceCardsPath(req.deviceId), []).sort((a,b)=> (b.createdAt||'').localeCompare(a.createdAt||''));
  res.json({ deviceId: req.deviceId, items: cards });
});

// upload photo -> estimate
app.post('/api/jobs/upload', memUpload.single('media'), async (req,res)=>{
  try {
    if (!rl(req.ip||'')) return res.status(429).json({ error:'rate_limited' });
    if (!req.file) return res.status(400).json({ error:'media_required' });
    if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(415).json({ error:'unsupported_type', allowed: ALLOWED_MIME });

    const deviceId = req.deviceId;
    const id = 'c_' + uuidv4();
    const stored = writeUpload(req.file.buffer, deviceId, id, req.file.mimetype);

    const infer = await inferFromImage(stored.abs, {}); // { aiLow, aiHigh, label }
    const tightened = precTighten(PREC, infer.label, infer.aiLow, infer.aiHigh);
    const now = new Date().toISOString();

    const card = {
      id, deviceId, createdAt: now,
      label: infer.label,
      aiLow: tightened.low,
      aiHigh: tightened.high,
      media: { url: stored.url, mimetype: req.file.mimetype, kind: 'image' }
    };

    const cardsPath = deviceCardsPath(deviceId);
    const cards = readJSON(cardsPath, []); cards.push(card); writeJSON(cardsPath, cards);

    logEstimate({ deviceId, source:'photo', label: card.label, aiLow: card.aiLow, aiHigh: card.aiHigh, cardId: id });
    logEvent('upload_photo', { cardId: id }, req);

    res.json(card);
  } catch (e) {
    console.error('upload_error', e);
    res.status(500).json({ error:'upload_failed' });
  }
});

// TRAIN endpoint (photo or video + label + price + description) — dev only
app.post('/api/train', memUpload.single('media'), async (req,res)=>{
  try{
    if (!DEV_TRAINING) return res.status(403).json({ error:'training_disabled' });
    if (!req.file) return res.status(400).json({ error:'media_required' });
    if (!ALLOWED_MIME.includes(req.file.mimetype)) return res.status(415).json({ error:'unsupported_type', allowed: ALLOWED_MIME });

    const deviceId = req.deviceId;
    const id = 't_' + uuidv4();
    const stored = writeUpload(req.file.buffer, deviceId, id, req.file.mimetype);

    const label = (req.body.label || 'General').slice(0,64);
    const priceUSD = Number(req.body.priceUSD);
    const description = String(req.body.description || '').slice(0, 4000);

    // optional transcript extraction when audio/video
    let transcript = null, fields = null;
    if (/^video\/|^audio\//.test(req.file.mimetype)) {
      const tr = await transcribeMedia(stored.abs); transcript = tr?.text || null;
      fields = extractFieldsFromTranscript(transcript || description);
    } else {
      fields = extractFieldsFromTranscript(description);
    }

    // update precision with ground truth (priceUSD) or fall back to fields.budgetHintUSD
    const gt = Number.isFinite(priceUSD) ? priceUSD : (Number.isFinite(fields?.budgetHintUSD) ? fields.budgetHintUSD : null);
    if (Number.isFinite(gt)) {
      PREC = precUpdate(PREC, label, gt);
      savePrecision(DATA_DIR, PREC);
    }

    // also log an estimate row for analytics
    logEstimate({
      deviceId, source: /^video\/|^audio\//.test(req.file.mimetype) ? 'video' : 'photo',
      label, userPrice: gt, transcript, fields, cardId: id
    });

    res.json({ ok:true, learned: Number.isFinite(gt) ? { label, priceUSD: gt } : null, mediaUrl: stored.url });
  } catch(e){
    console.error('train_error', e);
    res.status(500).json({ error:'train_failed' });
  }
});

// minimal capture config for UI
app.get('/api/capture-config', (req,res)=>{
  res.json({
    version: 1,
    endpoints: {
      photo: { url: '/api/jobs/upload', method: 'POST', field: 'media', accept: 'image/*' },
      train: { url: '/api/train', method: 'POST', field: 'media', accept: 'image/*,video/*,audio/*' }
    }
  });
});

// SPA fallback
app.get('*', (req,res)=> res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`WorkDeck (all-in-one) http://localhost:${PORT}  DATA_DIR=${DATA_DIR}`);
});
process.on('SIGTERM', ()=> server.close(()=>process.exit(0)));
