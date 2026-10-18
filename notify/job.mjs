// 花藻句帳 v4：通知の送信処理の本体（Firebase や送信の部品は外から渡す＝検証しやすくする）
import { decide } from "./notify-core.js";

// docs: [{ id, data, ref }]  send(sub, payload) → { ok, gone }  update(ref, { lastSent?, removeSubs[] })
export async function runJob({ docs, send, update, now = Date.now() }) {
  const sum = { users: docs.length, due: 0, sent: 0, failed: 0, removed: 0 };
  for (const doc of docs) {
    let decision;
    try { decision = decide(doc.data, now); } catch (e) { sum.failed++; continue; }
    if (!decision) continue;
    sum.due++;
    let anyOk = false;
    const removeSubs = [];
    for (const [key, sub] of Object.entries(doc.data.subs || {})) {
      const r = await send(sub, decision.payload);
      if (r.ok) { anyOk = true; sum.sent++; }
      else if (r.gone) { removeSubs.push(key); sum.removed++; }   // 端末側で通知をやめた・アプリを消した
      else sum.failed++;                                           // 一時的な失敗 → 次の回にもう一度
    }
    const fields = {};
    if (anyOk) fields.lastSent = decision.date;
    if (removeSubs.length) fields.removeSubs = removeSubs;
    if (Object.keys(fields).length) await update(doc.ref, fields);
  }
  return sum;
}
