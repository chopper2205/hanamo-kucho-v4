// 花藻句帳 v4：クラウドの控え（毎月の自動バックアップ）。アプリ側と送信側（GitHub Actions）の両方で使う
//
// クラウドの持ち方（1人あたり）
//   users/{uid}/backup/index            控えの一覧 { months: [{ id:"2026-10", at, n, counts }]（新しい順）, pre: { at, n, counts } }
//   users/{uid}/backup/before-restore   戻す直前の状態（取り消し用・直近1回分。かたまりの置き方は月の控えと同じ）
//   users/{uid}/backup/{YYYY-MM}        控え1件の目次 { at, n, sig[], counts, ver }
//   users/{uid}/backup/{YYYY-MM}/chunks/c0..  データのかたまり { s }（同期用のかたまりをそのまま複製）
//
// ・毎日1回動き、その月の控えがまだ無い人だけ控えを作る（＝毎月1日ごろに1回。失敗しても翌日やり直す）
// ・新しい順に KEEP 件だけ残し、古いものは消す
// ・句が急に半分以下に減っていたら（誤って消した可能性）、その月は古い控えを消さずに1件多く残す
// ・データが空のときは控えを作らない（空の控えで良い控えを押し出さない）
import { hash, isEmptyData, payloadOf, splitChunks } from "./merge.js";

export const KEEP = 3;
export const PRE_ID = "before-restore"; // 「この時点に戻す」を押す直前の状態（直近1回分。取り消し用）
export const indexPath = (uid) => `users/${uid}/backup/index`;
export const snapPath = (uid, id) => `users/${uid}/backup/${id}`;
export const snapChunkPath = (uid, id, i) => `users/${uid}/backup/${id}/chunks/c${i}`;

// 日本時間の「年-月」
export function monthId(nowMs) {
  const d = new Date(nowMs + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function countsOf(d) {
  return { haikus: (d.haikus || []).length, venues: (d.venues || []).length, submissions: (d.submissions || []).length };
}

// users: [{ uid, meta }]（meta は users/{uid}/sync/meta の中身）
// get(path) → data|null   set(path, data)   del(path)
export async function runBackup({ users, get, set, del, now = Date.now(), keep = KEEP }) {
  const sum = { users: users.length, made: 0, skipped: 0, empty: 0, retry: 0, removed: 0, failed: 0 };
  const id = monthId(now);
  for (const { uid, meta } of users) {
    try {
      const idx = (await get(indexPath(uid))) || { months: [] };
      const months = Array.isArray(idx.months) ? idx.months : [];
      if (months.some((m) => m.id === id)) { sum.skipped++; continue; }
      if (!meta || !Number.isInteger(meta.n) || !Array.isArray(meta.sig)) { sum.empty++; continue; }

      // 同期用のかたまりを読み、指紋で確かめる（読んでいる最中に書き換わったら、翌日やり直す）
      const parts = [];
      let moved = false;
      for (let i = 0; i < meta.n; i++) {
        const doc = await get(`users/${uid}/chunks/c${i}`);
        const s = doc ? doc.s : null;
        if (s == null || hash(s) !== meta.sig[i]) { moved = true; break; }
        parts.push(s);
      }
      if (moved) { sum.retry++; continue; }
      const d = JSON.parse(parts.join(""));
      if (isEmptyData(d)) { sum.empty++; continue; }
      const counts = countsOf(d);

      // かたまり → 目次 → 一覧 の順に書く（一覧に載るのは書き終わった控えだけ）
      for (let i = 0; i < parts.length; i++) await set(snapChunkPath(uid, id, i), { s: parts[i] });
      const at = now;
      await set(snapPath(uid, id), { at, n: parts.length, sig: meta.sig.slice(0, parts.length), counts, ver: meta.ver || 0 });

      const prev = months[0];
      const drop = !!(prev && prev.counts && prev.counts.haikus >= 10 && counts.haikus < prev.counts.haikus * 0.5);
      const entry = { id, at, n: parts.length, counts };
      if (drop) entry.drop = true;
      const all = [entry, ...months.filter((m) => m.id !== id)].sort((a, b) => (a.id < b.id ? 1 : -1));
      const limit = keep + (drop ? 1 : 0);
      const kept = all.slice(0, limit);
      const gone = all.slice(limit);
      await set(indexPath(uid), { ...idx, months: kept }); // 戻す直前の状態（pre）は消さない
      sum.made++;

      // 一覧から外したものを消す（失敗しても一覧には載らないので害はない）
      for (const g of gone) {
        try {
          for (let i = 0; i < (g.n || 0) + 1; i++) await del(snapChunkPath(uid, g.id, i));
          await del(snapPath(uid, g.id));
          sum.removed++;
        } catch (e) {}
      }
    } catch (e) {
      sum.failed++;
    }
  }
  return sum;
}

// 控え1件を読み出して、句帳のデータに戻す（アプリ側で使う）
export async function readSnapshot(get, uid, id) {
  const meta = await get(snapPath(uid, id));
  if (!meta) throw new Error("控えが見つかりません");
  const parts = [];
  for (let i = 0; i < meta.n; i++) {
    const doc = await get(snapChunkPath(uid, id, i));
    const s = doc ? doc.s : null;
    if (s == null || hash(s) !== meta.sig[i]) throw new Error("控えの一部が欠けています");
    parts.push(s);
  }
  const d = JSON.parse(parts.join(""));
  if (!d || !Array.isArray(d.haikus)) throw new Error("控えの形が正しくありません");
  return d;
}

// 退会時に消す文書の一覧
export async function backupPaths(get, uid) {
  const idx = await get(indexPath(uid));
  const paths = [];
  for (const m of (idx && idx.months) || []) {
    for (let i = 0; i < (m.n || 0) + 1; i++) paths.push(snapChunkPath(uid, m.id, i));
    paths.push(snapPath(uid, m.id));
  }
  if (idx && idx.pre) {
    for (let i = 0; i < (idx.pre.n || 0) + 1; i++) paths.push(snapChunkPath(uid, PRE_ID, i));
    paths.push(snapPath(uid, PRE_ID));
  }
  paths.push(indexPath(uid));
  return paths;
}

// 戻す直前の状態を、取り消し用の控えとしてクラウドに保存する（直近1回分を上書き）
// tx: { get(path), set(path, data), delete(path) }（トランザクションの中で呼ぶ）
export async function savePreRestore(tx, uid, d, at) {
  const idx = (await tx.get(indexPath(uid))) || { months: [] };
  const oldN = idx.pre ? idx.pre.n || 0 : 0;
  const chunks = splitChunks(payloadOf(d));
  const counts = countsOf(d);
  chunks.forEach((s, i) => tx.set(snapChunkPath(uid, PRE_ID, i), { s }));
  for (let i = chunks.length; i < oldN; i++) tx.delete(snapChunkPath(uid, PRE_ID, i));
  tx.set(snapPath(uid, PRE_ID), { at, n: chunks.length, sig: chunks.map(hash), counts });
  tx.set(indexPath(uid), { ...idx, months: Array.isArray(idx.months) ? idx.months : [], pre: { at, n: chunks.length, counts } });
}
