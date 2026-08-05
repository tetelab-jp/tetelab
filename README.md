# TETE AOUT（ホットペッパービューティー連携SaaS）

## プロジェクト概要
- **名称**: TETE AOUT（内部コード名: hotpepper-automation）
- **目的**: ホットペッパービューティーの「サロンボード」にはAPIが提供されていないため、サロンオーナーがブラウザから自社の投稿作業（スタイル投稿・ブログ投稿）を自動化できるSaaS型Webアプリケーションを構築する。
- **競合参考**: サロンパラダイス (https://www.salopara.com/)
- **テナント構造**: **1ユーザー = 1サロン**（マルチサロン管理には対応しない。全テーブルは`user_id`でスコープされる）

⚠️ **重要な前提（ユーザー確認済み）**
- サロンボードの利用規約リスクは許容の上で開発を進めている
- ID/Passを預かる仕組みのため、暗号化保存・同意取得を実装している（下記参照）
- 自動化方式は **Cloudflare Browser Rendering**（Phase 3で実装予定）を採用

## 現在完了している機能

### Phase 1: 認証・サロンボード連携設定
- ✅ サロンオーナー向けユーザー登録・ログイン・ログアウト（メール＋パスワード認証）
  - パスワードは PBKDF2 (100,000 iterations, SHA-256) でハッシュ化してD1に保存
  - セッションはJWT(HS256)をhttpOnly Cookieに格納（有効期限7日）
- ✅ サロンボード（ホットペッパービューティー管理画面）のログインID/パスワード登録・更新画面
  - **AES-GCM暗号化**してD1に保存（平文保存なし）
  - 利用規約・自動投稿への同意チェックボックス（`consent_given` / `consent_at`を記録）
  - 保存済みログインIDはマスク表示（例: `sa********`）
- ✅ 認証必須ルートの保護（未ログイン時は`/login`へリダイレクト、APIは401）

### Phase 2: スタイル投稿・ブログ投稿の準備機能
- ✅ **スタイル画像ライブラリ**（`/style/library`）
  - 複数画像の一括アップロード（1回最大30枚、Cloudflare R2に保存）
  - グリッド表示＋チェックボックスで「投稿対象」画像を選択（`is_selected`）
  - 選択中枚数のリアルタイム表示、全選択/全解除ボタン
  - 画像削除（R2・D1両方から削除）
- ✅ **スタイル投稿スケジュール設定**（`/style/schedule`）
  - 1日の投稿回数（1〜5回）と実行時刻を設定
  - 「選択画像数 × 投稿回数 = 1日の総投稿数」を画面上に表示（例: 100枚×3回=300投稿/日）
- ✅ **ブログマスタ設定**（`/blog/master`）
  - サロンプロフィール（コンセプト・ターゲット層・文体・NGワード）を事前登録
  - 投稿者（スタイリスト）・カテゴリ・クーポンのマスタデータCRUD（サロンボードのブログ投稿フォームの選択項目に対応）
- ✅ **ブログ投稿作成フォーム**（`/blog/posts`）
  - マスタデータから投稿者・カテゴリ・クーポンをドロップダウン選択
  - タイトル・本文・予約日時を入力し`posts`テーブルに保存（`post_type='blog'`）
  - AI生成ボタン（キーワード入力→サロンプロフィールを反映したタイトル・本文を自動生成、OpenAI API `gpt-4o-mini`使用）✅ 動作確認済み
- ✅ ダッシュボード（連携状況・スタイル画像選択数・投稿予約数・自動化方式の表示）

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
| GET | `/style/library` | 要 | スタイル画像ライブラリ（一覧・アップロードフォーム） |
| GET | `/style/library/image/:id` | 要 | R2画像本体を配信（`id`は`style_images.id`、所有者チェックあり） |
| POST | `/style/library/upload` | 要 | multipart `images`（最大30枚）を一括アップロード |
| POST | `/style/library/delete/:id` | 要 | 画像を削除（R2＋D1） |
| POST | `/api/style/toggle` | 要 | body `{imageId, selected}` — チェックボックス切替、`{success, selectedCount}`を返す |
| POST | `/api/style/bulk-select` | 要 | body `{selected}` — 全画像を一括選択/解除 |
| GET | `/style/schedule` | 要 | スタイル投稿スケジュール設定画面 |
| POST | `/style/schedule` | 要 | `enabled`, `times_per_day`, `run_time_slot[]` を保存 |
| GET | `/blog/master` | 要 | サロンプロフィール＋投稿者/カテゴリ/クーポンのマスタ管理画面 |
| POST | `/blog/master/profile` | 要 | サロンプロフィール（コンセプト等）を保存 |
| POST | `/blog/master/{authors\|categories\|coupons}/add` | 要 | マスタ項目を追加 |
| POST | `/blog/master/{authors\|categories\|coupons}/:id/delete` | 要 | マスタ項目を削除 |
| GET | `/blog/posts` | 要 | ブログ投稿作成フォーム＋直近20件の投稿一覧 |
| POST | `/blog/posts` | 要 | ブログ投稿を`posts`テーブルに保存（`status='pending'`） |
| POST | `/api/blog/generate` | 要 | body `{keywords}` — AIでタイトル・本文を生成（**現在401エラーでブロック中**） |

## データアーキテクチャ
- **DB**: Cloudflare D1 (`hotpepper-automation-production`)
- **ストレージ**: Cloudflare R2 (`hotpepper-automation-style-images`, binding: `STYLE_IMAGES`)
- **テナント構造**: 全テーブルは`user_id`で直接スコープ（マルチサロン非対応、`salons`テーブルは存在しない）
- **テーブル**:
  - `migrations/0001_initial_schema.sql`:
    - `users`: サロンオーナー（email, password_hash, salon_name）
    - `salon_credentials`: サロンボードID/Pass（AES-GCM暗号化列 `*_enc`、同意フラグ）
    - `posts`: ブログ/スタイル投稿予約（status: pending/processing/done/failed、Phase 2で`author_name`/`category_name`/`coupon_name`/`image_r2_key`列を追加）
    - `execution_logs`: 自動投稿ロボの実行結果ログ（Phase 3以降で使用）
  - `migrations/0002_multi_salon_support.sql`（※ファイル名は初期案の名残だが内容はuser_idスコープ）:
    - `style_images`: スタイル画像（user_id, r2_key, is_selected, post_count, sort_order等）
    - `style_post_schedules`: スタイル投稿スケジュール（user_id UNIQUE, enabled, times_per_day, run_times JSON）
    - `style_post_runs`: 実行履歴（Phase 3で使用予定）
    - `blog_authors` / `blog_categories` / `blog_coupons`: ブログマスタデータ（user_id, name, is_active, sort_order）
    - `salon_profiles`: サロンプロフィール（user_id UNIQUE, concept, target_customer, writing_tone, ng_words）
- **暗号化**:
  - `src/lib/crypto.ts` — Web Crypto API のみで実装（Node.js `crypto` 非依存、Cloudflare Workers対応）
  - パスワード: PBKDF2ハッシュ（`salt:hash` base64形式）
  - サロンボードID/Pass: AES-GCM（`ENCRYPTION_KEY` 環境変数で暗号化・復号）
- **認証**: `src/lib/jwt.ts`（HS256 JWT自作実装）+ `src/lib/auth-middleware.ts`（Honoミドルウェア）
- **AI生成**: `src/lib/ai-generate.ts` — OpenAI公式API（`https://api.openai.com/v1`, モデル: `gpt-4o-mini`）を`OPENAI_API_KEY`/`OPENAI_BASE_URL`で呼び出し

## 環境変数（Secrets）
| 変数名 | 用途 | ローカル設定場所 |
|---|---|---|
| `JWT_SECRET` | セッションJWTの署名鍵 | `.dev.vars`（gitignore対象） |
| `ENCRYPTION_KEY` | サロンボードID/PassのAES-GCM暗号化鍵（32byte base64） | `.dev.vars`（gitignore対象） |
| `OPENAI_API_KEY` | AIブログ生成用（OpenAI公式APIキー、ユーザー提供） | `.dev.vars`（gitignore対象） |
| `OPENAI_BASE_URL` | AIブログ生成用エンドポイント（`https://api.openai.com/v1`） | `.dev.vars`（gitignore対象） |

本番デプロイ時は `wrangler pages secret put JWT_SECRET` / `ENCRYPTION_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` で設定すること。
**⚠️ ENCRYPTION_KEYを変更すると既存の暗号化データが復号不能になるため、本番用の値は厳重に保管すること。**

## ユーザーガイド（簡易）
1. `/signup` でサロン名・メールアドレス・パスワードを入力し新規登録
2. ログイン後、ダッシュボードから「サロンボード連携設定」へ進み、サロンボードのログインID・パスワードを登録
3. **スタイル投稿**: `/style/library` で写真を一括アップロード→チェックボックスで投稿対象を選択→`/style/schedule` で1日の投稿回数・時刻を設定
4. **ブログ投稿**: `/blog/master` で投稿者・カテゴリ・クーポン・サロンプロフィールを登録→`/blog/posts` でAI生成または手入力で記事を作成し予約
5. （Phase 3以降）予約時刻になると自動投稿ロボ（Cloudflare Browser Rendering）がサロンボードにログインし投稿を実行

## 既知の問題
- 現時点で既知のブロッカーなし。AIブログ生成はユーザー提供のOpenAI公式APIキー（`gpt-4o-mini`）で動作確認済み。

## Phase 3 実装状況（2026-08-05時点）
- ✅ `browser`バインディング追加（wrangler.jsonc / types.ts）
- ✅ `src/lib/salonboard-automation.ts`: ログイン・スタイル登録・反映申請のPuppeteer実装
- ✅ `src/lib/style-post-runner.ts`: 1回分の実行ロジック（画像取得→投稿→ログ記録）
- ✅ `/style/template`: 投稿テンプレート設定画面（スタイリスト・カテゴリ等の共通設定）
- ✅ `/style/test-run`: 手動テスト実行画面・実行履歴表示
- ✅ `/api/automation/test-run`: テスト実行API（本人のみ）
- ✅ `/api/cron/run-style-posts`: 外部Cronトリガー受け口（`CRON_SECRET`によるBearer認証）
- ⚠️ **未検証・要確認**:
  - `SALONBOARD_BASE_URL`（実際のドメイン）
  - 写真アップロードモーダルの実際のDOM構造・アップロード方式（`salonboard-automation.ts`の`uploadFrontImage`はUI操作の一般的パターンで実装した未検証コード）
  - スタイリスト選択値・ヘアレングス選択値の実際の`<option value>`（`/style/template`でユーザー自身が入力する運用）
  - ブログ投稿の生HTML未取得（フォーム構造・POST先が未確定）
- ❌ Cloudflare Pagesはネイティブのcron triggerを持たないため、`/api/cron/run-style-posts`を定期的に呼び出す外部トリガー（別Workerや外部クロンサービス）は未構築
- ❌ 投稿失敗時の通知（メール/LINE等）
- ❌ パスワードリセット・メールアドレス確認フロー
- ❌ サロンボード利用規約の詳細確認・利用規約/プライバシーポリシーページ
- ❌ 本番Cloudflareアカウントへのデプロイ
- ❌ 実際のサロンボード環境での動作テスト（ローカルサンドボックスではBrowser Renderingは動作しないため、本番またはwrangler devのリモートモードでのテストが必須）

## 推奨する次の開発ステップ
1. **Phase 3着手**: Cloudflare Browser Rendering APIをWorkerから呼び出し、Cron Triggerで`style_post_schedules`/`posts`テーブルの`pending`予約を処理する自動投稿ロボを実装
2. 投稿失敗時のリトライ・通知機能
3. 本番Cloudflareアカウントへのデプロイ（D1/R2本番リソース作成、Secrets設定、`OPENAI_API_KEY`を`wrangler pages secret put`で設定）

## デプロイ状況
- **プラットフォーム**: Cloudflare Pages（未デプロイ、サンドボックス内でのみ動作確認済み）
- **技術スタック**: Hono + TypeScript + Cloudflare D1 + Cloudflare R2 + Web Crypto API + Tailwind CSS(自前ビルド) + FontAwesome(自前ホスト) + fetch API
- **自動化方式**: Cloudflare Browser Rendering（Phase 3で実装予定、Puppeteerベース）
- **最終更新**: 2026-08-05（TailwindCSS/FontAwesome/axiosのCDN依存を撤廃し自前ビルド/セルフホストに変更）
