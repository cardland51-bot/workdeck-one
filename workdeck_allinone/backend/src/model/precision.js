
// ESM quantile tracker (online) for tightening bands by label
import fs from 'fs'; import path from 'path';

const CFG = { qLow: 0.2, qHigh: 0.8, alpha: 0.12, blend: 0.6 };
const file = d => path.join(d, 'analytics', 'precision.json');

export function loadPrecision(DATA_DIR){
  try { return JSON.parse(fs.readFileSync(file(DATA_DIR),'utf8')); }
  catch { return { labels:{} }; }
}
export function savePrecision(DATA_DIR, model){
  fs.mkdirSync(path.join(DATA_DIR, 'analytics'), { recursive:true });
  fs.writeFileSync(file(DATA_DIR), JSON.stringify(model, null, 2));
}

function qUpdate(q, p, x, a){ if (q == null) return x; return q + a * ((x < q ? 1 : 0) - p) * Math.max(1, Math.abs(x - q)); }

export function update(model, label, price){
  if (!Number.isFinite(price)) return model;
  const k = label || 'General';
  const s = model.labels[k] || { n:0, qL:null, qH:null, mean:null };
  s.n++; s.qL = qUpdate(s.qL, CFG.qLow,  price, CFG.alpha);
         s.qH = qUpdate(s.qH, CFG.qHigh, price, CFG.alpha);
  s.mean = s.mean==null ? price : s.mean + 0.03*(price - s.mean);
  model.labels[k] = s; return model;
}

export function tighten(model, label, aiLow, aiHigh){
  const s = model.labels[label]; if (!s || s.qL==null || s.qH==null) return { low: aiLow, high: aiHigh };
  const qL = Math.round(s.qL), qH = Math.round(s.qH);
  const low  = Math.round(CFG.blend*qL + (1-CFG.blend)*aiLow);
  const high = Math.round(CFG.blend*qH + (1-CFG.blend)*aiHigh);
  return { low: Math.min(low, high-1), high };
}
