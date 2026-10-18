// 花藻句帳 v4：通知の判定（アプリ側と送信側の両方で使う、純粋な計算だけの部品）
//
// 通知用の文書 users/{uid}/notify/main
//   enabled  通知全体のオン/オフ
//   days     何日前に知らせるか（例 [3,1,0]。0＝当日）
//   hour     何時に知らせるか（0〜23。端末の地域時刻）
//   kinds    { deadline: 締切, broadcast: 放送・発表日 }
//   tz       時刻の地域（例 "Asia/Tokyo"）
//   items    近い予定だけの一覧 [{ k: "d"|"b", date: "YYYY-MM-DD", label: "○○句会「兼題」" }]
//            ※句の本文は入れない。送信処理はこの文書しか読まない
//   subs     通知を受け取る端末 { [key]: { endpoint, keys, ua, at } }
//   lastSent 最後に通知を送った日（同じ日に二重に送らないため。送信側が書く）

export const DAY_CHOICES = [14, 7, 3, 2, 1, 0];
export const DEFAULT_SETTINGS = { enabled: true, days: [3, 1, 0], hour: 9, kinds: { deadline: true, broadcast: true } };
const HORIZON = 30; // 30日先までの予定を通知用文書に載せる

const pad = (n) => String(n).padStart(2, "0");
export function localDateStr(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// 地域時刻での「今日の日付」と「何時か」
export function zonedNow(nowMs, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz || "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(f.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) % 24 };
}

export function daysBetween(fromDate, toDate) {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10));
  const b = Date.UTC(+toDate.slice(0, 4), +toDate.slice(5, 7) - 1, +toDate.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

// 句帳のデータから、通知用の「近い予定」一覧を作る
//   締切：まだ投句していない（投句日が空）もの。締切タブの「締切」と同じ条件
//   発表：放送・発表日が今日以降のもの
export function computeItems(data, today) {
  const vname = {};
  for (const v of (data && data.venues) || []) vname[v.id] = v.name || "（名称未設定）";
  const out = [];
  for (const s of (data && data.submissions) || []) {
    const th = (s.theme || "").trim();
    const label = (vname[s.venueId] || "（投句先未設定）") + (th ? (/^[「『]/.test(th) ? th : `「${th}」`) : "");
    if (s.deadline && !s.submittedOn) {
      const d = daysBetween(today, s.deadline);
      if (d >= 0 && d <= HORIZON) out.push({ k: "d", date: s.deadline, label });
    }
    if (s.broadcastOn) {
      const d = daysBetween(today, s.broadcastOn);
      if (d >= 0 && d <= HORIZON) out.push({ k: "b", date: s.broadcastOn, label });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.k.localeCompare(b.k) || a.label.localeCompare(b.label));
  return out;
}

const whenText = (n) => (n === 0 ? "今日" : n === 1 ? "明日" : `あと${n}日`);

// 送信するかどうかの判定。送るなら { payload, date } を返す
//   ・設定した時刻を過ぎていて、今日まだ送っていなければ送る（定時処理が遅れても取りこぼさない）
//   ・今日が「◯日前」に当たる予定が1件も無ければ送らない
export function decide(doc, nowMs) {
  if (!doc || !doc.enabled) return null;
  if (!doc.subs || Object.keys(doc.subs).length === 0) return null;
  const { date, hour } = zonedNow(nowMs, doc.tz);
  const target = Number.isInteger(doc.hour) ? doc.hour : 9;
  if (hour < target) return null;
  if (doc.lastSent === date) return null;
  const days = Array.isArray(doc.days) ? doc.days : [];
  const kinds = doc.kinds || {};
  const due = [];
  for (const it of doc.items || []) {
    if (it.k === "d" && !kinds.deadline) continue;
    if (it.k === "b" && !kinds.broadcast) continue;
    const n = daysBetween(date, it.date);
    if (days.includes(n)) due.push({ ...it, n });
  }
  if (due.length === 0) return null;
  due.sort((a, b) => a.n - b.n || a.k.localeCompare(b.k));
  const lines = due.slice(0, 4).map((it) => (it.k === "d" ? `${whenText(it.n)}〆切　${it.label}` : `${whenText(it.n)}発表　${it.label}`));
  if (due.length > 4) lines.push(`ほか${due.length - 4}件`);
  const anyDeadline = due.some((it) => it.k === "d");
  const title = anyDeadline ? (due[0].n === 0 && due[0].k === "d" ? "今日が締切の投句があります" : "締切が近づいています") : "放送・発表の予定";
  return { date, payload: { title, body: lines.join("\n"), tag: "hanamo-" + date, url: "./" } };
}

// 端末の登録を文書のキーにするための短い名前（Firestoreのフィールド名に使えない「.」を避ける）
export function subKey(endpoint) {
  let h = 2166136261;
  for (let i = 0; i < endpoint.length; i++) { h ^= endpoint.charCodeAt(i); h = Math.imul(h, 16777619); }
  return "s" + (h >>> 0).toString(36) + endpoint.length.toString(36);
}
