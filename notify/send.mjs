// 花藻句帳 v4：通知の送信（GitHub Actions から1時間ごとに実行）
//
// 必要な秘密情報（GitHub → Settings → Secrets and variables → Actions）
//   FIREBASE_SERVICE_ACCOUNT  Firebaseのサービスアカウント鍵（JSONをそのまま）
//   VAPID_PRIVATE_KEY         通知用の秘密鍵
// ワークフローに直接書く値（公開してよい）
//   VAPID_PUBLIC_KEY, VAPID_SUBJECT
//
// ※公開リポジトリの実行ログは誰でも見られるため、件数以外（名前・投句先・メールアドレス等）は一切出力しない
import admin from "firebase-admin";
import webpush from "web-push";
import { runJob } from "./job.mjs";

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`設定がありません: ${k}`); process.exit(1); } return v; };
const sa = JSON.parse(need("FIREBASE_SERVICE_ACCOUNT"));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
webpush.setVapidDetails(need("VAPID_SUBJECT"), need("VAPID_PUBLIC_KEY"), need("VAPID_PRIVATE_KEY"));

// 全員の通知用文書だけを読む（句のデータには触れない）。読み取りは人数分
const snap = await db.collectionGroup("notify").get();
const docs = snap.docs.filter((d) => d.id === "main").map((d) => ({ id: d.ref.path, data: d.data(), ref: d.ref }));

const sum = await runJob({
  docs,
  send: async (sub, payload) => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "normal" });
      return { ok: true };
    } catch (e) {
      const code = e && e.statusCode;
      return { ok: false, gone: code === 404 || code === 410 };
    }
  },
  update: async (ref, f) => {
    const u = {};
    if (f.lastSent) u.lastSent = f.lastSent;
    for (const k of f.removeSubs || []) u[`subs.${k}`] = admin.firestore.FieldValue.delete();
    await ref.update(u);
  },
});

console.log(`通知の確認: 利用者${sum.users}人 / 送信対象${sum.due}人 / 送信${sum.sent}件 / 失敗${sum.failed}件 / 無効な端末の削除${sum.removed}件`);
