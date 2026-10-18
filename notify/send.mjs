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

// どの段階で失敗したかを、秘密の中身を出さずに知らせる
const fail = (stage, hint, e) => {
  const code = e && (e.code || e.status || e.statusCode) ? `（種別: ${e.code || e.status || e.statusCode}）` : "";
  const msg = e && e.message ? String(e.message).split("\n")[0].replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[鍵]").slice(0, 200) : "";
  console.error(`✗ ${stage}で失敗しました${code}\n  考えられる原因: ${hint}\n  詳細: ${msg}`);
  process.exit(1);
};
const need = (k, hint) => { const v = (process.env[k] || "").trim(); if (!v) fail(`設定 ${k} の読み込み`, hint || `GitHub の Secrets に ${k} が登録されていない（名前の綴り違いを含む）`); return v; };

let sa;
try { sa = JSON.parse(need("FIREBASE_SERVICE_ACCOUNT")); }
catch (e) { fail("サービスアカウント鍵（FIREBASE_SERVICE_ACCOUNT）の読み取り", "JSONファイルの中身が全部貼られていない（最初の { から最後の } まで）、または余計な文字が混ざっている", e); }
if (!sa.private_key || !sa.client_email || !sa.project_id) fail("サービスアカウント鍵の確認", "貼ったJSONがサービスアカウント鍵ではない（private_key / client_email / project_id が無い）。Firebaseの「サービス アカウント」→「新しい秘密鍵を生成」でできたファイルの中身を貼る");
console.log(`① 鍵を読み込みました（プロジェクト: ${sa.project_id}）`);
try { webpush.setVapidDetails(need("VAPID_SUBJECT"), need("VAPID_PUBLIC_KEY"), need("VAPID_PRIVATE_KEY")); }
catch (e) { fail("通知用の鍵（VAPID）の確認", "VAPID_PRIVATE_KEY の値が違う（前後の空白や改行、1文字欠けなど）", e); }
console.log("② 通知用の鍵を確認しました");

let db;
try { admin.initializeApp({ credential: admin.credential.cert(sa) }); db = admin.firestore(); }
catch (e) { fail("Firebaseへの接続準備", "サービスアカウント鍵が壊れている（貼り付け時に改行が崩れた等）。鍵を作り直して貼り直す", e); }

// 全員の通知用文書だけを読む（句のデータには触れない）。読み取りは人数分
let snap;
try { snap = await db.collectionGroup("notify").get(); }
catch (e) { fail("Firestoreの読み取り", "鍵のプロジェクトがアプリと違う／鍵が無効化された／Firestoreが作成されていない", e); }
console.log(`③ 通知用の文書を読みました（${snap.size}件）`);
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
