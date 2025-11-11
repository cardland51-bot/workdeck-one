
export default async function inferFromImage(filePath, opts = {}) {
  const base = (filePath || '').split(/[\\/]/).pop();
  const seed = Array.from(base).reduce((a,c)=>a + c.charCodeAt(0), 0) || 137;
  const low = 120 + (seed % 140);
  const high = low + 160 + (seed % 90);
  const label = ['Irrigation Repair','Sod Install','Tree Trim','General Repair','Hardscape'][seed % 5];
  return { aiLow: low, aiHigh: high, label, notes: 'stub-range' };
}
