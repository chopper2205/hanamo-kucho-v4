// 花藻句帳 v4：端末間の合流（3方向マージ）
// base   = 前回同期したときの内容（両端末に共通の出発点）
// local  = この端末の今の内容
// remote = クラウドの今の内容
// 句・投句先・投句記録を id ごとに比べ、
//   ・片方だけが変えた → その変更を採る
//   ・両方が同じに変えた → そのまま
//   ・両方が違うように変えた → この端末（local）を採る
//   ・片方が削除、もう片方が書き換え → 書き換えを残す（消えて困る方を守る）

const COLLECTIONS = ["haikus", "venues", "submissions"];

// キーの並び順に左右されない比較用の文字列
function stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

function indexById(arr) {
  const m = new Map();
  for (const x of arr || []) if (x && x.id != null) m.set(String(x.id), x);
  return m;
}

function mergeCollection(b, l, r, stats) {
  const B = indexById(b), L = indexById(l), R = indexById(r);
  // 並び順：クラウドの並びを基準に、この端末だけにあるものを後ろへ（この端末での並び順のまま）
  const order = [];
  const seen = new Set();
  for (const x of r || []) if (x && x.id != null && !seen.has(String(x.id))) { seen.add(String(x.id)); order.push(String(x.id)); }
  for (const x of l || []) if (x && x.id != null && !seen.has(String(x.id))) { seen.add(String(x.id)); order.push(String(x.id)); }
  for (const id of B.keys()) if (!seen.has(id)) { seen.add(id); order.push(id); }

  const out = [];
  for (const id of order) {
    const bv = B.get(id), lv = L.get(id), rv = R.get(id);
    const bs = bv === undefined ? null : stable(bv);
    const ls = lv === undefined ? null : stable(lv);
    const rs = rv === undefined ? null : stable(rv);
    let pick;
    if (ls === rs) pick = lv;                 // 同じ（両方無い場合も含む）
    else if (bs === ls) pick = rv;            // この端末は変えていない → クラウドを採る（削除も含む）
    else if (bs === rs) pick = lv;            // クラウドは変わっていない → この端末を採る（削除も含む）
    else if (lv === undefined) { pick = rv; stats.keptOverDelete++; }  // こちらで削除・向こうで書き換え → 残す
    else if (rv === undefined) { pick = lv; stats.keptOverDelete++; }  // 向こうで削除・こちらで書き換え → 残す
    else { pick = lv; stats.conflicts++; }     // 両方で別々に書き換え → この端末を採る
    if (pick !== undefined) out.push(pick);
  }
  return out;
}

export function merge3(base, local, remote) {
  const b = base || {}, l = local || {}, r = remote || {};
  const stats = { conflicts: 0, keptOverDelete: 0 };
  const out = { version: l.version || r.version || 1 };
  for (const c of COLLECTIONS) out[c] = mergeCollection(b[c], l[c], r[c], stats);
  return { data: out, stats };
}

// 保存用の文字列（アプリ本体の saveData と同じ並び：句を末尾に）
export function payloadOf(d) {
  return JSON.stringify({ version: (d && d.version) || 1, venues: (d && d.venues) || [], submissions: (d && d.submissions) || [], haikus: (d && d.haikus) || [] });
}

export function isEmptyData(d) {
  return !d || COLLECTIONS.every((c) => !d[c] || d[c].length === 0);
}

// かたまり分割と指紋（内容から計算する短いハッシュ）
export const REMOTE_CHUNK = 150000; // 1かたまり15万文字（日本語でも約450KB。Firestoreの1件上限1MBに余裕を持たせる）
export function splitChunks(payload) {
  const out = [];
  for (let i = 0; i < payload.length; i += REMOTE_CHUNK) out.push(payload.slice(i, i + REMOTE_CHUNK));
  if (out.length === 0) out.push("");
  return out;
}
export function hash(str) {
  // cyrb53（衝突しにくい53bitハッシュ）＋長さ
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "." + str.length.toString(36);
}
