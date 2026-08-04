# TETE AOUT（ホットペッパービューティー連携SaaS）

## プロジェクト概要
- **名称**: TETE AOUT（内部コード名: hotpepper-automation）
- **目的**: ホットペッパービューティーの「サロンボード」にはAPIが提供されていないため、サロンオーナーがブラウザから自社の投稿作業（ブログ・スタイル投稿）を自動化できるSaaS型Webアプリケーションを構築する。
- **競合参考**: サロンパラダイス (https://www.salopara.com/) — ログインIDごとに独立した作業領域を持つ外部連携システム。

⚠️ **重要な前提（ユーザー確認済み）**
- サロンボードの利用規約リスクは許容の上で開発を進めている
- ID/Passを預かる仕組みのため、暗号化保存・同意取得を実装している（下記参照）
- 自動化方式は **Cloudflare Browser Rendering**（Phase 3で実装予定）を採用

## 現在完了している機能（Phase 1）
- ✅ サロンオーナー向けユーザー登録・ログイン・ログアウト（メール＋パスワード認証）
  - パスワードは PBKDF2 (100,000 iterations, SHA-256) でハッシュ化してD1に保存
  - セッションはJWT(HS256)をhttpOnly Cookieに格納（有効期限7日）
- ✅ サロンボード（ホットペッパービューティー管理画面）のログインID/パスワード登録・更新画面
  - **AES-GCM暗号化**してD1に保存（平文保存なし）
  - 利用規約・自動投稿への同意チェックボックス（`consent_given` / `consent_at`を記録）
  - 保存済みログインIDはマスク表示（例: `sa********`）
- ✅ ダッシュボード（連携状況・投稿予約数の表示、開発ロードマップの可視化）
- ✅ 認証必須ルートの保護（未ログイン時は`/login`へリダイレクト、APIは401）

## 現在の機能エントリ一覧（パス・パラメータ）

| メソッド | パス | 認証 | 説明 |
|---|---|---|---|
| GET | `/` | - | ログイン状態に応じて `/dashboard` or `/login` にリダイレクト |
| GET | `/signup` | - | 新規登録画面（クエリ `error` でエラー表示） |
| POST | `/signup` | - | `email`, `password`, `salon_name` を受け取り登録＋自動ログイン |
| GET | `/login` | - | ログイン画面（クエリ `error` でエラー表示） |
| POST | `/login` | - | `email`, `password` でログイン |
| POST | `/logout` | 要 | セッションCookie削除 |
| GET | `/dashboard` | 要 | ダッシュボード画面 |
| GET | `/settings/salonboard` | 要 | サロンボードID/Pass登録・確認画面（クエリ `saved`, `error`） |
| POST | `/settings/salonboard` | 要 | `salonboard_login_id`, `salonboard_password`, `consent` を暗号化して保存 |

## データアーキテクチャ
- **DB**: Cloudflare D1 (`hotpepper-automation-production`)
- **テーブル**（`migrations/0001_initial_schema.sql`）:
  - `users`: サロンオーナー（email, password_hash, salon_name）
  - `salon_credentials`: サロンボードID/Pass（AES-GCM暗号化列 `*_enc`、同意フラグ）
  - `posts`: ブログ/スタイル投稿予約（Phase 2以降で使用。status: pending/processing/done/failed）
  - `execution_logs`: 自動投稿ロボの実行結果ログ（Phase 3以降で使用）
- **暗号化**:
  - `src/lib/crypto.ts` — Web Crypto API のみで実装（Node.js `crypto` 非依存、Cloudflare Workers対応）
  - パスワード: PBKDF2ハッシュ（`salt:hash` base64形式）
  - サロンボードID/Pass: AES-GCM（`ENCRYPTION_KEY` 環境変数で暗号化・復号）
- **認証**: `src/lib/jwt.ts`（HS256 JWT自作実装）+ `src/lib/auth-middleware.ts`（Honoミドルウェア）

## 環境変数（Secrets）
| 変数名 | 用途 | ローカル設定場所 |
|---|---|---|
| `JWT_SECRET` | セッションJWTの署名鍵 | `.dev.vars`（gitignore対象） |
| `ENCRYPTION_KEY` | サロンボードID/PassのAES-GCM暗号化鍵（32byte base64） | `.dev.vars`（gitignore対象） |

本番デプロイ時は `wrangler pages secret put JWT_SECRET` / `ENCRYPTION_KEY` で設定すること。
**⚠️ ENCRYPTION_KEYを変更すると既存の暗号化データが復号不能になるため、本番用の値は厳重に保管すること。**

## ユーザーガイド（簡易）
1. `/signup` でサロン名・メールアドレス・パスワードを入力し新規登録
2. ログイン後、ダッシュボードから「サロンボード連携設定」へ進む
3. サロンボードのログインID・パスワードを入力し、同意チェックを入れて保存
4. （Phase 2以降）ブログ・スタイル投稿の内容を入力・AI生成し、投稿予約を作成
5. （Phase 3以降）予約時刻になると自動投稿ロボ（Cloudflare Browser Rendering）がサロンボードにログインし投稿を実行

## まだ実装されていない機能
- ❌ Phase 2: ブログ/スタイル投稿の入力フォーム・AI（ChatGPT/Claude API）による本文自動生成・R2への画像保存
- ❌ Phase 3: Cloudflare Browser Renderingによるサロンボードへの自動ログイン・自動投稿の実行（Cron Trigger連携）
- ❌ 投稿失敗時の通知（メール/LINE等）
- ❌ 複数店舗・複数オーナー対応のマルチテナント権限設計の強化
- ❌ パスワードリセット・メールアドレス確認フロー
- ❌ サロンボード利用規約の詳細確認・利用規約/プライバシーポリシーページ

## 推奨する次の開発ステップ
1. **Phase 2着手**: `/posts/new` でブログ・スタイル投稿フォームを実装し、`posts`テーブルに保存
2. AI生成機能: Hono API route (`/api/generate-blog`) からOpenAI/Claude APIを呼び出し（APIキーは`wrangler secret`で管理）
3. スタイル写真のアップロード: Cloudflare R2バケットを追加し画像を保存
4. **Phase 3着手**: Cloudflare Browser Rendering APIをWorkerから呼び出し、Cron Triggerで`posts`テーブルの`pending`予約を処理
5. 本番Cloudflareアカウントへのデプロイ（D1本番データベース作成、Secrets設定）

## デプロイ状況
- **プラットフォーム**: Cloudflare Pages（未デプロイ、サンドボックス内でのみ動作確認済み）
- **技術スタック**: Hono + TypeScript + Cloudflare D1 + Web Crypto API + Tailwind CSS(CDN)
- **自動化方式**: Cloudflare Browser Rendering（Phase 3で実装予定、Puppeteerベース）
- **最終更新**: 2026-08-04
