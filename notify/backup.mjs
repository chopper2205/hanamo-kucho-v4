// 花藻句帳 v4：クラウドの控え（GitHub Actions から毎日1回実行。その月の控えが無い人だけ作る）
//
// 必要な秘密情報：FIREBASE_SERVICE_ACCOUNT（通知と同じ鍵）
// ※公開リポジトリの実行ログは誰でも見られるため、件数以外は一切出力しない
import admin from "firebase-admin";
import { runBackup, KEEP } from "./backup-core.js";

const fail = (stage, hint, e) => {
  const code = e && (e.code || e.status) ? `（種別: ${e.code || e.status}）` : "";
  const msg = e && e.message ? String(e.message).split("\n")[0].replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, "[鍵]").slice(0, 200) : "";
  console.error(`✗ ${stage}で失敗しました${code}\n  考えられる原因: ${hint}\n  詳細: ${msg}`);
  process.exit(1);
};

let sa;
try { sa = JSON.parse((process.env.FIREBASE_SERVICE_ACCOUNT || "").trim()); }
catch (e) { fail("サービスアカウント鍵の読み取り", "Secrets の FIREBASE_SERVICE_ACCOUNT が未登録、または中身が欠けている", e); }
let db;
try { admin.initializeApp({ credential: admin.credential.cert(sa) }); db = admin.firestore(); }
catch (e) { fail("Firebaseへの接続準備", "サービスアカウント鍵が壊れている", e); }

// 同期の目次（users/{uid}/sync/meta）だけを全員分読む。読み取りは人数分
let snap;
try { snap = await db.collectionGroup("sync").get(); }
catch (e) { fail("Firestoreの読み取り", "鍵のプロジェクトがアプリと違う／鍵が無効化された", e); }
const users = snap.docs.filter((d) => d.id === "meta" && d.ref.parent.parent).map((d) => ({ uid: d.ref.parent.parent.id, meta: d.data() }));

const sum = await runBackup({
  users,
  get: async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; },
  set: async (p, data) => { await db.doc(p).set(data); },
  del: async (p) => { await db.doc(p).delete(); },
});
console.log(`控えの確認: 利用者${sum.users}人 / 今回作成${sum.made}人 / 作成済み${sum.skipped}人 / データなし${sum.empty}人 / 翌日やり直し${sum.retry}人 / 古い控えの削除${sum.removed}件 / 失敗${sum.failed}人（各自${KEEP}か月分を保持）`);
if (sum.failed) process.exitCode = 1;
