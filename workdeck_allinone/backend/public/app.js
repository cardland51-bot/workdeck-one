const BASE = window.BACKEND || location.origin;
const $ = (id)=>document.getElementById(id);
const deck = $('deck'); const statusEl = $('status');

function toast(m){ statusEl.textContent = m; setTimeout(()=> statusEl.textContent='', 2000); }

async function upload(endpoint, file, extra = {}){
  const fd = new FormData();
  fd.append('media', file);
  for (const [k,v] of Object.entries(extra)) fd.append(k, v);
  const res = await fetch(`${BASE}${endpoint}`, { method:'POST', body: fd, credentials:'include' });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function cardNode(c){
  const el = document.createElement('div'); el.className='card';
  const media = c.media?.mimetype?.startsWith('video/') ? `<video src="${c.media.url}" controls></video>` : `<img src="${c.media?.url||''}">`;
  el.innerHTML = `${media}
  <div class="band">${c.label||'Estimate'}</div>
  <div>Low: $${c.aiLow} — High: $${c.aiHigh}</div>
  <small>${c.createdAt||''}</small>`;
  return el;
}

async function refresh(){
  const res = await fetch(`${BASE}/api/jobs/list`, { credentials:'include' });
  const j = await res.json();
  deck.innerHTML='';
  (j.items||[]).forEach(c => deck.appendChild(cardNode(c)));
}

$('btnPhoto').onclick = async () => {
  const f = $('photo').files?.[0]; if(!f) return toast('Pick a photo');
  try { toast('Uploading…'); const j = await upload('/api/jobs/upload', f); deck.prepend(cardNode(j)); toast('Done'); }
  catch(e){ toast('Failed'); console.error(e); }
};

$('btnTrain').onclick = async () => {
  const f = $('trainMedia').files?.[0]; if(!f) return toast('Pick media');
  const label = $('label').value.trim(); const price = $('price').value.trim(); const desc = $('desc').value.trim();
  try { toast('Teaching…'); const j = await upload('/api/train', f, { label, priceUSD: price, description: desc }); toast(j.ok ? 'Learned' : 'Done'); }
  catch(e){ toast('Failed'); console.error(e); }
};

refresh();
