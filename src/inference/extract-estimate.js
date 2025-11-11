
export function extractFieldsFromTranscript(text='') {
  const t = String(text).toLowerCase();
  const budget = /\$?\s*(\d{2,5})\s*(budget|bucks|dollars)/.exec(t)?.[1];
  const label = /irrigation|valve|sprinkler/.test(t) ? 'Irrigation Repair' : 'General Repair';
  return { budgetHintUSD: budget ? Number(budget) : null, label };
}
