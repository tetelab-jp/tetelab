# TETE AOUT — Claude Code 引き継ぎ資料

> このドキュメントは、GenSparkサンドボックスでの開発から Claude Code(ローカル/Anthropic API直契約)への
> 移行のために作成された引き継ぎ資料です。Phase 1・Phase 2は実装・動作確認済み。
> Phase 3(Cloudflare Browser Rendering自動投稿)は **未着手**。本ドキュメントに実装方針を全て記載します。

## 1. プロジェクト概要

- **サービス名**: TETE AOUT
- **目的**: Hot Pepper Beauty「サロンボード」管理画面(公式APIなし)を自動操作するSaaS
- **対象自動化**: ①スタイル投稿(フォトギャラリー) ②ブログ投稿
- **アーキテクチャ**: 1ユーザー = 1サロン(マルチテナント/salon_id設計は明示的に不採用)
- **技術スタック**: Hono + TypeScript + Cloudflare Pages/Workers + D1(SQLite) + R2(画像) + Web Crypto API
- **フロントエンド**: JSXサーバーレンダリング(`hono/jsx-renderer`) + TailwindCSS(自前ビルド、後述の追記参照)
- **禁止事項**: Node.js `fs`/`crypto`/`child_process`等は使用不可(Workers runtime制約)。暗号化はWeb Crypto APIのみ。

## 2. 現在の実装状況

### ✅ Phase 1(完了・動作確認済み)
- ユーザー認証(signup/login/logout): `src/routes/auth.tsx`
- JWTセッション管理(HS256, Web Crypto API自前実装): `src/lib/jwt.ts`, `src/lib/auth-middleware.ts`
  - Cookie名: `session`(定数 `SESSION_COOKIE_NAME`)、httpOnly、7日間有効
- サロンボードID/Pass登録画面(AES-GCM暗号化保存): `/settings/salonboard`(`src/routes/dashboard.tsx`内)
  - 暗号化/復号: `src/lib/crypto.ts` の `encryptSecret()` / `decryptSecret()`
  - `ENCRYPTION_KEY` 環境変数(base64, 32byte推奨)が必要

### ✅ Phase 2(完了・動作確認済み)
- スタイル画像ライブラリ: `src/routes/style.tsx`
  - R2(`STYLE_IMAGES`バインディング)に画像アップロード、`style_images`テーブルで管理
  - チェックボックスで投稿対象を選択(`is_selected`カラム)、一括選択/解除API
  - `GET/POST /style/library`, `POST /style/library/upload`, `POST /style/library/delete/:id`
  - `POST /api/style/toggle`(個別チェック切替), `POST /api/style/bulk-select`(全選択/解除)
- スタイル投稿スケジュール設定: `GET/POST /style/schedule`
  - `style_post_schedules`テーブル: `enabled`, `times_per_day`, `run_times`(JSON配列 例 `["09:00","13:00","18:00"]`)
  - **重要な仕様**: 1回の実行 = その時点で`is_selected=1`の画像**すべて**を投稿する(N枚 × M回/日)
- ブログマスタ設定: 投稿者(`blog_authors`)、カテゴリ(`blog_categories`)、クーポン(`blog_coupons`)、
  サロン基本情報(`salon_profiles` — AI生成のコンテキストとして使用)
- AI生成ブログ本文: `src/lib/ai-generate.ts`
  - **OpenAI公式API**を使用(GenSparkのLLMプロキシは401エラーで断念し切替済み)
  - `OPENAI_API_KEY`, `OPENAI_BASE_URL=https://api.openai.com/v1`, モデル `gpt-4o-mini`
  - `POST /api/blog/generate` で動作確認済み(curl・アプリ経由の両方でOK)

### ❌ Phase 3(未着手 — これから実装するのはここ)
Cloudflare Browser Rendering(`@cloudflare/puppeteer`)によるサロンボード自動操作。
**依存パッケージは追加済み**(`package.json`に`@cloudflare/puppeteer: ^1.2.0`を追加済み。要`npm install`実行)だが、
**実装コードはまだ1行も存在しない**。以下、必要な作業をすべて記載する。

## 3. 【最重要】ユーザーからの確定仕様(必読)

これまでの対話でユーザーから明確な回答を得た設計判断:

1. **反映申請(公開)は完全自動化する** ✅
   - 「登録(下書き保存)→反映申請(公開)」の2ステップを**両方Puppeteerで自動実行**する
   - 手動確認・手動ボタン押下のステップは **挟まない**(「自動反映でないと意味がない」と明言)
   - スタイル投稿はサロンボード上で登録と反映申請が別アクションのため、2ステップとも自動化が必須

2. **スタイル公開設定(公開/非公開ラジオボタン)は画像登録時に設定済みという前提** ✅
   - Phase 2の画像ライブラリ登録時にユーザー側で設定される想定
   - Phase 3の自動投稿フローでは、この項目を明示操作する必要はない(デフォルト値のまま進めてよい)

3. **ブログ投稿は1段階のみ(反映申請は不要)** ✅
   - スタイル投稿とは異なり、ブログは「登録」ボタンのPOSTだけで公開完了
   - 2段階フロー(登録→反映申請)は**ブログには実装しない**

## 4. サロンボード実サイトの技術仕様(生HTMLから抽出済み)

ユーザーから提供された5ページの生HTML(①ログイン画面 ②ログイン後トップ ③掲載管理TOP
④スタイル一覧 ⑤スタイル投稿編集画面)を解析した結果。**ブログ投稿画面のHTMLはまだ未提供**
(Phase 3実装時に追加でユーザーに依頼する必要あり)。

### 4-1. ログイン
- 見た目のフォーム`action`は **おとり**: `/CNC/idPasswordInput/`
- 実際のPOST先: `/CNC/login/doLogin/`(フィールド: `userId`, `password`)
- JS関数 `dologin()` が `<a>`タグの`onclick`に紐づいており、これを経由してPOSTされる(通常のsubmitボタンではない)
- フォームID: `idPasswordInputForm`
- → Puppeteerでは `page.type()` で入力後、`page.click()` でこの`<a>`をクリック、または
   `dologin()`相当のJS実行/直接POSTのいずれかで実装。ナビゲーション待機(`waitForNavigation`)必須。

### 4-2. ログイン後トップページ
- 大半のナビは通常の`<a href>`
- 「掲載管理」は特殊な`cmsLink`パターン: 対象URLが子要素`<span class="hidden_url">`に埋め込まれ、
  `$.shuhari.cmsForward`経由で遷移。実際の遷移先: `/CNB/reflect/reflectTop/`

### 4-3. 掲載管理TOPページ
- サブナビ: スタイル(`/CNB/draft/styleList/`)、ブログ(`/CLP/bt/blog/blogList/`)
- **反映申請ボタンは1つで、サロン/スタイリスト/スタイル/メニュー/こだわりをまとめて処理**
  - POST先: `/CNB/reflect/storeReflect/doRegister/`
  - JS関数: `reflected(event, element)` → `CNBjsFormSubmitWithName('reflectedData', "/CNB/reflect/storeReflect/doRegister/", '_self')`
- 特集・クーポンは**別々の**反映申請ボタン/エンドポイント:
  - 特集: `reflectedSpecial()` → `/CNB/reflect/storeSpecialReflect/doRegister/`
  - クーポン: `reflectedCpn()` → `/CNB/reflect/couponReflect/doRegister/`
  - → **スタイル投稿の自動化では通常の反映申請ボタン(`reflected`系)だけで良い**
- 反映申請後、実際に公開されるまで**約20分**かかる(サロンボード側の仕様)
- 「要確認」ステータスは通常運用でよくあるもので、反映申請をブロックしない。
  ブロックされるのは「NG」判定または「未確認」が残っている場合のみ。

### 4-4. スタイル一覧ページ(フォーム構成)
| フォームID | 用途 | POST先 | トリガーJS関数 |
|---|---|---|---|
| `addStyleForm` | 新規スタイル作成(空POST) | `/CNB/draft/styleEdit/` | `addStyle()` |
| `editStyleForm` | 既存スタイル編集(styleId付きPOST) | `/CNB/draft/styleEdit/` | `editStyle(event, styleId)` |
| `delStyleForm` | 削除 | `/CNB/draft/styleList/doDelete` | `delStyle()` |
| `presentStyleForm` | 公開/非公開切替 | `/CNB/draft/styleList/doPresent` | `unpresentStyle()`/`presentStyle()` |
| `selectStyleForm` | ページネーション(約150件/2ページ) | — | `doSelectLink`/`doSelectNext`/`doSelectLast` |

### 4-5. スタイル投稿編集フォーム(最重要・最複雑)
```html
<form id="styleEditForm" method="POST" action="/CNB/draft/styleEdit/doRegister" onsubmit="return false;">
```
- **通常のHTML submitは無効化されている**(`onsubmit="return false;"`)
- 保存(登録)ボタンは `onclick="doRegister(event); return false;"` → JS経由で
  `/CNB/draft/styleEdit/doRegister/` にPOST
- 必須フィールド一覧:
  | フィールド名 | 種別 | 必須 | 備考 |
  |---|---|---|---|
  | `frmStyleEditStyleInfoDto.styleRegistFormat` | radio | ◯ | `"0"`=画像 / `"1"`=動画。**自動化では`"0"`固定**。初回保存後は変更不可(2回目以降JSで無効化) |
  | `frmStyleEditStylistCommentDto.stylistId` | select (`#stylistCheckCd`) | ◯ | スタイリスト選択 |
  | `frmStyleEditStylistCommentDto.stylistComment` | textarea (`#stylistCommentTxt`) | ◯ | 最大240文字 |
  | `frmStyleEditStyleDto.styleName` | text (`#styleNameTxt`) | ◯ | 最大60文字 |
  | `frmStyleEditStyleDto.styleCategoryCd` | radio (`#styleCategoryCd01`/`02`) | ◯ | `SG01`=レディース / `SG02`=メンズ |
  | `frmStyleEditStyleDto.ladiesHairLengthCd` または `.mensHairLengthCd` | select | ◯ | カテゴリ選択でJSにより表示切替 |
  | `frmStyleEditStyleDto.menuContentsCdList` | checkbox | — | `MC01`〜`MC04` |
  | `frmStyleEditStyleDto.menuContents` | textarea (`#menuDetailTxt`) | ◯ | 最大100文字 |
  | 髪量/髪質/顔型/太さ/クセ/年代等 | radio | — | 全て未設定`"99"`がデフォルト。**自動化では触らずデフォルトのままでよい** |
  | ヘアスタイル特集(`hairCatalogSpecialCd`) | select | — | 期間限定キャンペーン用。**自動化では空欄のままでよい** |
  | クーポン | モーダル選択(`.jsc_SB_modal_trigger.jsc_SB_modal_single_coupon`) | — | 単純なフィールドではない |
  | ハッシュタグ | 動的タグ追加(`#hashTagTxt` + 追加ボタン) | — | |

#### ⚠️ 最大の技術的難所: 写真アップロード
- `<input type="file">` ではなく **JS駆動のモーダル**:
  1. プレースホルダー画像 `<img id="FRONT_IMG_ID_IMG" class="img_new_no_photo">` をクリック
  2. `img_upload_modal_view('FRONT_IMG_ID', 'ABNKD3600_FRONT', dataKey, false, 'styleEditForm')` が発火し
     `#imageUploaderModalBody` モーダルが開く
  3. アップロード成功時のコールバック `setUploadImage(imageId, setImgId, meetStandardFlg, lengthSize, sideSize, resolution, imageFilePath)`
     が隠しフィールド `FRONT_IMG_ID`/`SIDE_IMG_ID`/`BACK_IMG_ID` にセットし、`<img>`のsrcを更新
- **推奨アプローチ**: 見た目のUI操作(クリック連打)をPuppeteerで再現するのではなく、
  モーダル内部が実際に呼んでいる**アップロードAJAXリクエストを直接特定して叩く**方が安定する可能性が高い。
  Phase 3着手時、Chrome DevTools NetworkタブでこのモーダルのアップロードリクエストのURL/フォーマットを
  実際に確認するステップが必要(現時点では未確認)。

### 4-6. スタイル投稿の公開フロー(2ステップ・自動化対象)
1. **登録(下書き保存)**: `styleEditForm` → `/CNB/draft/styleEdit/doRegister/`(`doRegister(event)`経由)
2. **反映申請(公開)**: 掲載管理TOPの共通ボタン → `/CNB/reflect/storeReflect/doRegister/`(`reflected(event, element)`経由)
- **この2ステップを両方自動実行することが確定仕様**(上記セクション3参照)

### 4-7. ブログ投稿(HTML未取得・要追加調査)
- ユーザー回答により **1段階のみ**(登録ボタンのPOSTだけで公開完了、反映申請は不要)と判明
- ただし実際のフォームフィールド名・POST先URL・投稿者/カテゴリ/クーポン選択のUI構造は
  **まだ生HTMLを解析していない**
- **Phase 3着手時に必ずユーザーへ依頼すること**: ブログ一覧(`/CLP/bt/blog/blogList/`)と
  ブログ投稿作成/編集フォームの生HTMLダンプ

## 5. データベーススキーマ(既存・変更不要)

```sql
-- migrations/0001_initial_schema.sql
users, salon_credentials(暗号化ID/Pass), posts, execution_logs

-- migrations/0002_multi_salon_support.sql (※ファイル名は歴史的経緯でmulti_salonだが実際は1ユーザー1サロン仕様)
style_images(R2画像ライブラリ, is_selected, post_count, last_posted_at),
style_post_schedules(enabled, times_per_day, run_times JSON),
style_post_runs(実行履歴 status: pending/processing/done/failed),
blog_authors, blog_categories, blog_coupons, salon_profiles
```

- `execution_logs`テーブルと`style_post_runs`テーブルは**スキーマは存在するがコードから書き込まれていない**
  → Phase 3実装時、Puppeteer実行結果(成功/失敗/エラーメッセージ)を必ずこれらに書き込むこと

## 6. Phase 3実装に必要な作業(未着手・すべてこれから)

### 6-1. インフラ設定
- [x] `package.json`に`@cloudflare/puppeteer: ^1.2.0`追加済み(`npm install`実行が必要)
- [ ] `wrangler.jsonc`に`browser`バインディング追加:
  ```jsonc
  "browser": { "binding": "BROWSER" }
  ```
- [ ] `src/types.ts`の`Bindings`型に`BROWSER: Fetcher`(または`@cloudflare/puppeteer`の型)を追加
- [ ] Cloudflare側でBrowser Renderingを有効化(APIトークンのパーミッション確認)
- [ ] ローカルサンドボックスの`wrangler pages dev --local`ではBrowser Renderingは完全にエミュレートできないため、
      **実機能テストは本番(または`wrangler dev`のリモートモード)デプロイが必要**

### 6-2. 実装するモジュール(未作成)
- `src/lib/salonboard-automation.ts` (または `src/routes/automation.ts`)
  - `loginToSalonBoard(browser, loginId, password)`: `/CNC/login/doLogin/`
  - `postStyle(page, styleData)`: 登録(`/CNB/draft/styleEdit/doRegister/`) + 反映申請(`/CNB/reflect/storeReflect/doRegister/`)を**両方**実行
  - `postBlog(page, blogData)`: 登録のみ(反映申請なし) ※要ブログHTML解析
  - 各処理の成功/失敗を`execution_logs`/`style_post_runs`に記録

### 6-3. スケジューラ
- Cron Trigger(`wrangler.jsonc`の`triggers.crons`)で定期実行
- `style_post_schedules`の`run_times`と現在時刻を突き合わせ、該当するユーザーの
  `style_images WHERE is_selected=1`を全件取得して`postStyle()`をループ実行
- 実行結果を`style_post_runs`(1回の実行単位)+`execution_logs`(個別ログ)に記録

### 6-4. 認証情報の取得
- `salon_credentials`テーブルから`decryptSecret()`(`src/lib/crypto.ts`)でID/Passを復号し、
  Puppeteerのログイン処理に渡す(平文はメモリ内のみ、絶対にログ出力しない)

### 6-5. 未解決の設計課題(ユーザーとの再確認が必要)
- **実credentialでの安全なテスト運用フロー**: 実際のサロンボードID/Passでの動作確認方法について、
  「チャットで直接ID/Passを渡す」のは避け、既存の暗号化フォーム(`/settings/salonboard`)経由で
  登録してもらい、「テスト実行」ボタン(結果ログのみ返す・パスワードは絶対に返さない)を
  別途実装する案を提示したが、ユーザーからの最終同意はまだ得ていない。Phase 3のコードが
  ある程度動く状態になった時点で再度相談すること。
- **ブログ投稿画面の生HTML**: まだユーザーから提供されていない。ブログ自動化の実装前に必須。
- **写真アップロードのAJAXエンドポイント**: 実際のDevTools調査が必要(未確認)。

## 7. 環境変数(Cloudflare Pages / .dev.vars)

```
JWT_SECRET=<ランダム文字列>
ENCRYPTION_KEY=<base64, 32byte — crypto.tsのgenerateEncryptionKeyBase64()で生成可>
OPENAI_API_KEY=<ユーザー自身のOpenAI APIキー>
OPENAI_BASE_URL=https://api.openai.com/v1
```

## 8. 開発コマンド

```bash
npm install
npm run build
pm2 start ecosystem.config.cjs   # または: npx wrangler pages dev dist --d1=... --r2=STYLE_IMAGES --local --ip 0.0.0.0 --port 3000

# DB migration
npm run db:migrate:local
npm run db:migrate:prod

# デプロイ
npm run deploy
```

## 9. ユーザーからの重要な前提

- HPBの利用規約に違反するリスクを**明示的に承知の上で自動化を進めることに同意済み**(法的リスクは自己責任として容認)
- 「1ユーザー=1サロン」構成を明示的に希望・確定(マルチテナント/salon_id設計は不採用)

---

## 追記（2026-08-05, Claude.ai上での引き継ぎ後の作業）

前回のGenspark上のセッションからプロジェクト一式（zip）を引き継ぎ、Phase 3の実装に着手した。

### このセッションで実装したこと
1. `wrangler.jsonc` / `src/types.ts` に `BROWSER` バインディングを追加
2. `src/lib/salonboard-automation.ts` を新規作成
   - `loginToSalonBoard()`: `/CNC/login/doLogin/` を叩く `dologin()` をpage.evaluateで直接呼び出し
   - `draftRegisterStyle()`: `addStyle()` → `styleEditForm` 入力 → `doRegister` ボタンクリック
   - `submitReflectApplication()`: 掲載管理TOPで `reflected(` にマッチする要素をクリック
   - `uploadFrontImage()`: **未検証**。モーダルを開いてinput[type=file]にBase64経由でFileを注入する一般的パターンで実装したが、実際のモーダルDOM構造は未確認のまま
3. `src/lib/style-post-runner.ts`: 1回の実行（対象画像取得→ループ投稿→`style_post_runs`/`execution_logs`への記録）を共通化
4. `migrations/0003_style_post_template.sql`: 「投稿テンプレート」テーブルを新設
   - **重要な設計判断**: サロンボードのスタイル投稿フォームはスタイリスト・カテゴリ・ヘアレングス・メニュー詳細・コメントが必須だが、Phase 2の画像ライブラリはタイトル程度しか収集していなかった。画像1枚ごとに毎回入力させるのは運用上非現実的なため、「共通テンプレートを1つ設定し全画像に適用する」方式にした。画像ごとに内容を変えたい場合は将来的に`style_images`へ個別カラムを追加する拡張が必要。
5. `/style/template`（GET/POST）: テンプレート設定画面（`src/routes/style.tsx`に追加）
6. `/style/test-run`（GET）、`/api/automation/test-run`（POST）、`/api/cron/run-style-posts`（POST）: `src/routes/automation.ts` として新規作成
   - テスト実行はログイン中ユーザー本人のみ実行可能、パスワードは画面・レスポンスに一切含めない
   - Cloudflare Pagesはネイティブcron triggerを持たないため、外部から`CRON_SECRET`付きBearer認証で叩く受け口として実装（呼び出し元の定期実行の仕組み自体は別途構築が必要）
7. `README.md`にPhase 3実装状況セクションを追記

### 次にやるべきこと（優先順位順）
1. **写真アップロードの実装検証**: 実際にサロンボードにログインし、Chrome DevTools NetworkタブでスタイルEdit画面の画像アップロードモーダルの挙動を確認。`uploadFrontImage()`のセレクタ・ロジックを実際のDOMに合わせて修正。
2. **本番/リモート環境でのE2Eテスト**: ローカルサンドボックス（`wrangler pages dev --local`）ではBrowser Renderingは動作しないため、Cloudflareにデプロイするか`wrangler dev`のリモートモードでテストが必要。まずはテスト用のダミーアカウント、または本人の実アカウントで少数枚のテスト投稿から始めることを推奨。
3. **`/style/template`の実際の値の入力**: スタイリスト選択値・ヘアレングス選択値は、実際のサロンボードのHTML（`<select>`の`<option value>`）を見て正しい値をユーザーに入力してもらう必要がある。
4. **外部Cronトリガーの構築**: `/api/cron/run-style-posts`を定期的に叩く仕組み（軽量な別Cloudflare Workerを1つ作りCron Triggerを設定→fetchでこのエンドポイントを呼ぶ、が一番シンプル）。
5. **ブログ投稿の自動化**: 生HTML未取得のため着手不可。ブログ一覧・編集画面のHTMLダンプをユーザーに依頼する。

### セキュリティに関する注意
アップロードされた `.dev.vars` に実際のOpenAI APIキーが平文で含まれていた（gitには含まれていないことは確認済み）。共有環境を経由したキーなので、念のためOpenAI側でローテーション（キー再発行）することを推奨する。

---

## 追記（2026-08-05, Claude Code on the web上での引き継ぎ後の作業）

Claude.ai上のセッションからzip一式（webapp.zip / webappphase3.zip）を引き継ぎ、
`tetelab-jp/tetelab` リポジトリの `claude/genspark-cloude-migration-gjssen` ブランチとして
GitHub上に移設した（PR #1）。gitの元コミット履歴（Genspark由来の7コミット）はそのまま保持。

### このセッションで実施したこと
1. **既存の型エラーを解消**（優先度4の着手前に発見・修正）
   - `tsconfig.json` に `@cloudflare/workers-types` を追加し、`D1Database`/`R2Bucket`/`Fetcher`型を解決
   - `src/lib/salonboard-automation.ts` の `page.evaluate()` コールバック（ブラウザ側で実行されるコード）向けに
     `/// <reference lib="dom" />` を追加し、`window`/`document`/`HTMLFormElement`等の型エラーを解消
   - `src/lib/crypto.ts` / `src/lib/jwt.ts` の `Uint8Array` を `Uint8Array<ArrayBuffer>` に明示し、
     `BufferSource`への型不一致を解消
   - `automation.ts` → `automation.tsx` にリネーム（JSXを含むのに拡張子が`.ts`のままでビルド失敗していた）
   - `npx tsc --noEmit` がクリーンになることを確認済み
2. **外部Cronトリガーの構築**（「次にやるべきこと」優先度4に対応）
   - `cron-trigger-worker/` を新規プロジェクトとして追加。独立した `package.json`/`wrangler.jsonc`/`tsconfig.json`を持つ
   - 1分間隔（`* * * * *`）で本体アプリの `/api/cron/run-style-posts` を`CRON_SECRET`付きBearer認証で叩く
   - デプロイ手順は `cron-trigger-worker/README.md` に記載（`TARGET_URL`は本体アプリのデプロイ後URLに要書き換え）

### わかったこと・今後の作業者への注意
- **このセッションが動いていたクラウド実行環境からは、Cloudflare（`api.cloudflare.com`含む）を含むほぼ全ての外部ホストへの通信がネットワークポリシーでブロックされていた**（`cdn.tailwindcss.com`/`cdn.jsdelivr.net`も同様に403）。そのため、このセッション内ではCloudflareへの実デプロイも、TailwindCSS等CDN込みのデザイン確認もできなかった。
  - 実際にCloudflareへデプロイする／CDN込みでデザインを確認する作業は、**ローカルPC上のClaude Code（またはインターネット制限のない環境）で行う必要がある**。
- 上記の制約により、「次にやるべきこと」の1〜3・5番（実サロンボードへのログイン確認、本番E2Eテスト、`/style/template`の実測値入力、ブログHTML解析）はこのセッションでは着手不可だった。次の担当者（人またはAI）が実施すること。

### 追記2: TailwindCSS/FontAwesome/axiosのCDN依存を撤廃

上記の通信制限が判明したことをきっかけに、そもそも本番運用としても好ましくない
「CDN経由でTailwindCSS/FontAwesome/axiosを読み込む」設計自体を見直した
（TailwindCSSの公式ドキュメントでも `cdn.tailwindcss.com` は「本番環境では非推奨」と明記されている）。

- **TailwindCSS**: `tailwindcss` / `@tailwindcss/cli` (v4)をdevDependenciesに追加。
  `src/tailwind-input.css`(`@import "tailwindcss";`のみ)を入力に、
  `npm run build:css`(`tailwindcss -i ./src/tailwind-input.css -o ./public/static/tailwind.css --minify`)
  でJSX内のクラス使用を自動スキャンして`public/static/tailwind.css`を生成。`npm run build`に組み込み済み。
- **FontAwesome**: `@fortawesome/fontawesome-free`(v7)をdevDependenciesに追加し、
  `css/all.min.css`と`webfonts/*.woff2`を`public/static/fontawesome/`にコピーして自前ホスト化。
  移行時に使用中の全アイコンクラスがv7 Free版に存在することを確認済み。
  なお`fa-sparkles`は元々Free版に存在しないアイコン名だった(Genspark時代からの軽微な不具合)ため、
  `fa-wand-magic-sparkles`に修正した。
- **axios**: 使用箇所(`public/static/blog-post.js`, `public/static/style-library.js`)を
  すべてネイティブの`fetch()`に置き換え、CDN読み込み自体を削除。
- `src/renderer.tsx`から`<script src="https://cdn...">`/`<link href="https://cdn...">`を全て削除し、
  `/static/tailwind.css`・`/static/fontawesome/css/all.min.css`をローカル参照に変更。
- 生成物である`public/static/tailwind.css`はリポジトリにコミット済み(サイズも19KB程度と小さいため)。
  **Tailwindのクラスを新規追加・変更した場合は`npm run build:css`を実行して再コミットすること**
  (`npm run build`にも組み込まれているため、デプロイ時は自動で最新化される)。

この変更により、外部ネットワーク接続が制限された環境でも、本体アプリの見た目を含めた
動作確認が可能になった(実際にこのセッション内のサンドボックスでスクリーンショットにより確認済み)。

### 次にやるべきこと（優先順位順・更新）
1. **写真アップロードの実装検証**（未着手）: HANDOFF.md旧セクション6-5と同内容。実サロンボードへのログインが必要。
2. **本番/リモート環境でのE2Eテスト**（未着手）: Cloudflareへの実デプロイが前提。ローカルPCまたはCI等、外部ネットワーク制限のない環境で実施すること。
3. **`/style/template`の実際の値の入力**（未着手）: 実サロンボードのHTML確認が必要。
4. **外部Cronトリガーの構築**: ✅ コード実装完了（`cron-trigger-worker/`）。実際のデプロイ・`TARGET_URL`/`CRON_SECRET`設定は未実施。
5. **ブログ投稿の自動化**（未着手）: ブログ一覧・編集画面の生HTMLダンプが必要。

## 追記（2026-08-08, Phase 3 MVP再設計）

ユーザー提供の競合3サイト分析・詳細MVP仕様書・実サロンボードHTML（スタイル一覧/編集、
スタイリスト一覧、クーポン一覧）をもとに、店舗全体でスタイルを一元管理する新データモデルへ
全面移行した。詳細設計は `docs/phase3-mvp-design.md` を参照。要点は以下の通り。

### データモデルの再設計（マイグレーション0004・0005）
- `blog_authors` → `stylists`、`blog_coupons` → `coupons` に統合・改名し、
  スタイル投稿とブログ投稿の両方で共有する共通マスタとした（`salonboard_stylist_key`/
  `salonboard_coupon_key` でサロンボード側の内部IDと紐付け）。
- 旧`style_images`（1行=1画像）を廃止し、`styles`（1行=1スタイル投稿の内容）+
  `style_images`（`image_role`付きの子テーブル、FRONT画像など）に分割。
- `styles`に3段階の状態管理カラムを追加: `internal_save_status`(draft/ready/disabled)、
  `salonboard_register_status`(not_started/success/failed)、
  `reflection_request_status`(not_started/pending/success/failed/blocked)。
  「自動投稿完了」はサロンボードの**反映申請(公開)が成功したこと**で定義する
  （ユーザー確定仕様、内部保存だけでは完了扱いにしない）。
- 旧`style_post_templates`を廃止し、複数テンプレートを使い回せる`templates`テーブルを新設。
- 0005で`templates.menu_detail_text`カラム追加漏れを修正（ローカルE2E確認中に発覚）。

### スタイリスト/クーポンの自動取得
- `src/lib/salonboard-sync.ts`: サロンボードの「スタイリスト一覧」「クーポン一覧」ページを
  Puppeteerでスクレイピングし、`stylists`/`coupons`テーブルへupsertする関数群を実装済み。
  セレクタは実HTML（`/CNB/draft/stylistList/`, `/CNB/draft/couponList/`）から確認済みだが、
  **実行はBrowser Rendering環境が必要なため、このセッション内では未実行**。
  `/settings/salonboard`画面への同期ボタン設置はまだ未実施（次にやるべきこと）。

### 新スキーマに合わせたルート全面書き直し
マイグレーション適用により壊れた以下4ファイルを新スキーマに合わせて再実装済み
（`npx tsc --noEmit`・`npm run build`・`wrangler pages dev --local`でのE2E動作確認済み:
サインアップ→スタイリスト/クーポン登録→スタイル新規作成（画像あり/なし）→編集→
自動投稿トグルAPI→テンプレート作成/編集まで一通り確認）。

- `src/routes/dashboard.tsx`: 集計クエリを`styles`/`auto_post_enabled_flag`ベースに変更。
- `src/routes/blog.tsx`: `blog_authors`/`blog_coupons`への参照を`stylists`/`coupons`に変更。
- `src/lib/style-post-runner.ts`: 「登録（下書き保存）」と「反映申請（公開）」を別ステップとして
  実行し、それぞれの成否を`styles.salonboard_register_status`/`reflection_request_status`に
  個別記録するよう変更（旧`postStyleImageFull`の一括呼び出しから分離）。
- `src/routes/style.tsx`: スタイル一覧（`/style/library`）・作成/編集フォーム
  （`/style/new`, `/style/:id/edit`）・自動投稿スケジュール（`/style/schedule`）・
  テンプレート管理（`/style/template`系）を新スキーマで全面書き直し。
  カテゴリ（レディース/メンズ）に応じた長さセレクトの表示切替用に
  `public/static/style-form.js`を新規作成。

### 次にやるべきこと（優先順位順・更新2）
1. **`/settings/salonboard`にスタイリスト/クーポン同期ボタンを設置**し、
   `salonboard-sync.ts`の`syncStylists()`/`syncCoupons()`を実際に呼び出せるようにする。
2. **本番/リモート環境でのE2Eテスト**（未着手・変わらず）: Cloudflareへの実デプロイまたは
   `wrangler dev`のリモートモードが前提。写真アップロード（モーダル操作）の実装検証も含む。
3. **既存スタイルのインポート機能**（`docs/phase3-mvp-design.md` Phase 3-F、未着手）:
   サロンボードに既に登録済みのスタイルを`styles`テーブルへ取り込む機能。
4. **NG/未確認ワード等によるブロック検知**（Phase 3-G、未着手）: 反映申請前に
   サロンボード側のブロック要因をチェックし`reflection_request_status='blocked'`にする処理。
5. **ブログ投稿の自動化**（未着手・変わらず）: ブログ一覧・編集画面の生HTMLダンプが必要。

## 追記（2026-08-08 その2、ユーザーの実機テストフィードバック対応）

ユーザーがローカルPC（`npm run dev:sandbox`）で実際にアプリを操作し、以下の指摘を受けて対応した。

### 対応した指摘
1. **モデル情報の入力欄がない** → `styles`/`templates`両テーブルに元々あった
   `model_attributes_json`カラムがフォームに露出していなかっただけ。髪量/髪質/太さ/
   クセ/顔型/年代の6項目を`style.tsx`の`ModelAttributeFields`コンポーネントとして追加
   （値のコード自体は`docs/phase3-mvp-design.md` 4-6参照。1〜3スケールの表示文言は
   実HTML未確認のため暫定表記であることをコード上にコメントで明記）。
2. **一度登録したスタイルを再編集できない** → 実際にはサーバー側は正常に動作していた
   （ローカルE2Eで確認済み）。原因はUIの発見しにくさで、編集導線がタイトルの
   テキストリンクのみだったため。一覧を行レイアウトに変更し、明示的な「編集」ボタンを追加。
3. **スタイル一覧の画像が欠けている** → `object-cover`で固定高さの箱に詰めていたため
   トリミングされていた。`object-contain`に変更し、全体が見えるようにした。
   あわせて「スタイルポストのように横一列」という要望通り、グリッドカードから
   1行1スタイルの行レイアウトに変更。
4. **テンプレートとスタイル投稿の項目を統一したい（画像だけ設定すればいいように）** →
   `templates`テーブルに元々あった`title_template`カラムもフォーム未露出だったため追加。
   さらに`/style/new`に「テンプレートから作成」ドロップダウンを追加し、選択すると
   画像以外の全項目（スタイル名・コメント・カテゴリ・長さ・メニュー・ハッシュタグ・
   クーポン・モデル情報）が自動入力されるようにした（`style-form.js`のJS側で実装）。
5. **自動投稿スケジュールをユーザー選択式ではなく「毎朝7:00から順次投稿・1日最大100件」
   の固定方式にしたい** → `style_post_schedules`テーブルから`times_per_day`/`run_times`
   カラムを削除（migration 0006）し、`enabled`フラグのみに簡素化。
   `style-post-runner.ts`のクエリに`ORDER BY sort_order, id ASC LIMIT 100`を追加、
   `automation.tsx`の外部Cron受け口を`run_times`照合ではなく固定文字列`'07:00'`との
   比較に変更。あわせて、既に反映申請成功済み（`reflection_request_status='success'`）
   のスタイルは対象から除外するようにした（従来は成功済みでも毎回再投稿されてしまう
   潜在バグがあったため）。

### 対応中に見つけた重大バグ2件（ユーザーからの指摘とは別）
- **外部Cronエンドポイントが到達不能だった**: `dashboard.tsx`/`style.tsx`/`blog.tsx`が
  それぞれ`.use('*', requireAuth)`でセッション認証必須にしていたが、Honoの
  `app.route('/', subApp)`はサブアプリの`.use('*', ...)`をアプリ全体のワイルドカード
  ミドルウェアとしてマージするため、これらより後にマウントされていた`automation.tsx`の
  `/api/cron/run-style-posts`（`CRON_SECRET`のBearer認証のみで動く想定）が、
  ログインセッションが無いと`dashboard`側の`requireAuth`に横取りされ401になっていた。
  `src/index.tsx`で`automation`を`dashboard`/`style`/`blog`より先にマウントする順序に
  修正して解決（`automation`自身が明示的に`requireAuth`を付けているルートは影響なし）。
  **この修正が無いと、毎朝7:00の自動投稿は外部Cronから一切トリガーされない。**
- **テンプレート自動入力JSが常に無効化されていた**: `style-form.js`が
  `document.querySelector('form')`でフォームを取得していたが、ページの左サイドバーに
  ログアウト用の`<form>`がDOM上で先に存在するため、常にそちらを誤って取得していた。
  `.category-radio`要素の`closest('form')`で本来のフォームを取得するよう修正。

### 動作確認方法
`wrangler pages dev`のローカル環境 + Playwright（headless Chromium）で、テンプレート
選択→自動入力の実際のJS挙動、モデル情報の保存・再表示、スタイル再編集、スケジュール
保存、Cronエンドポイントの認証到達性（POST限定・requireAuthに横取りされないこと）まで
すべて実際にブラウザ/HTTPリクエストで確認済み。

## 追記（2026-08-08 その3、Phase 3-D/E/F/G実装）

ユーザーから「既存スタイル取り込み・テンプレート一括適用・実行履歴汎用化・
NG/未確認ブロック検知をすべて同時に進めてほしい」との指示を受け、4つとも実装した。
サロンボードへの実接続が必要な検証（既存スタイル取り込み・NG検知）は
「テスト環境の状態がすべて確定してから」という方針のため、コードは完成させたが
実サイトでの動作確認は次のデプロイ時に持ち越し。

### Phase 3-G: NG/未確認ワード等のブロック検知
`src/lib/salonboard-automation.ts`に`checkReflectBlockers(page)`と
`ReflectionBlockedError`を追加。`submitReflectApplication()`は反映申請ボタンを
押す前に掲載管理TOPページのテキストから「NGワード」「未確認」等のキーワードを
検索し、見つかった場合は`ReflectionBlockedError`をthrowして反映申請自体を行わない。
`style-post-runner.ts`側でこれを捕捉し、`styles.reflection_request_status='blocked'`
（通常の`failed`とは区別）として記録する。
**⚠️ 実際の掲載管理TOPページでNG/未確認がどう表示されるか(DOM構造・文言)は未確認**
のため、キーワード検索によるベストエフォート実装。実サイト確認後、確実な
セレクタベースの判定に置き換えること。

### Phase 3-E: 実行履歴画面の汎用化
`automation.tsx`の`/style/test-run`を刷新。
- `execution_logs`の`execution_type`（登録/反映申請）を表示し、関連スタイルへの
  リンクを追加
- `blocked`ステータス用のバッジ色（amber）を追加
- 「失敗・ブロック中のスタイル」一覧と個別「再実行」ボタンを追加
  （`POST /api/style/:id/retry`新設）
- `style-post-runner.ts`は1件分の「登録＋反映申請」処理を`processStyleRow()`
  として関数化し、通常のバッチ実行(`runStyleAutomationForUser`)と
  単体再実行(`retryStylePost`)の両方から共有する構造にリファクタリング

### Phase 3-D: テンプレート一括適用
`POST /api/style/bulk-apply-template`を新設。`/style/library`画面で
チェックボックス（既存の「自動投稿対象」チェックを流用）で選んだスタイルに、
選択したテンプレートの内容を一括反映する。**画像・スタイル名・担当スタイリストは
上書きしない**（画像とスタイリストは指示書通り、スタイル名は「複数スタイルに同じ
タイトルが付くのはおかしい」という判断で対象外とした）。結果は
`batch_template_apply_logs`に記録。

### Phase 3-F: 既存スタイル取り込み
`src/lib/salonboard-import.ts`を新設。
- `fetchExistingStyles(page, log)`: スタイル一覧ページを巡回し、`styleId`
  （`L`+9桁形式、HANDOFF.md 4-4で確認済み）とタイトルらしき文字列を取得
- `fetchStyleDetail(page, styleId, log)`: 既存スタイル編集画面
  （HANDOFF.md 4-4記載の`editStyle(event, styleId)`で遷移）を開き、
  `draftRegisterStyle()`が書き込みに使っているのと同じセレクタ
  （実HTML確認済み）でフィールド値を読み取る
- `importSelectedStyles(...)`: 選択されたスタイルを取り込み、画像は
  ブラウザのCookieセッション経由でfetchしR2へ保存、`styles`へ
  `source_type='imported_from_salon_board'`、`internal_save_status='ready'`、
  `salonboard_register_status`/`reflection_request_status`は
  （既に実サイトで公開済みのはずのため）`'success'`で保存する。
  重複投稿を避けるため`auto_post_enabled_flag=0`（初期OFF）とする。
- `/style/import`画面：「一覧取得」→チェックボックスで選択→「取り込む」の
  2ステップUI（`style-import.js`）

**⚠️ `fetchExistingStyles()`のスタイル一覧ページの行DOM構造は実HTML未確認**。
`styleId`形式（`L\d{9}`）の正規表現でhidden input/リンク等から抽出する
ベストエフォート実装になっている。実際の一覧HTMLを確認後、確実な
セレクタベースの実装に置き換えること。ページネーションの「次へ」トリガー
（`doSelectNext`と推測）も未確認。

### ローカルでの動作確認範囲
Browser Renderingが必要な部分（ブラウザ起動より先）は、このセッションの
ネットワーク制限下では検証できない。ローカル`wrangler pages dev`では、
これらのAPI（`/api/style/import/fetch-list`・`/api/style/import/execute`・
`/api/style/:id/retry`）を呼ぶと「ブラウザ起動失敗」のエラーがJSON形式で
正しく返ること（＝コードパスがブラウザ起動の直前まで正常に到達すること）
まで確認済み。それ以外（テンプレート一括適用のDB更新、実行履歴画面の表示、
再実行ボタンのUI表示）は実際にDBへ書き込み・確認済み。

## 追記（2026-08-08 その4、自動投稿の分散実行方式への変更）

ユーザーから「毎朝7:00に一括投稿ではなく、7:00〜24:00の間に均等に分散して
投稿したい」との要望があり、変更した。

### 変更内容
- `style-post-runner.ts`に`shouldPostNextStyle()`（ペース判定）・
  `runNextStyleForUser()`（1件だけ処理する版の実行関数）を追加。
- 判定ロジック：外部Cronが呼ばれるたびに「残り時間(24:00まで) ÷
  残り対象件数」で理想の投稿間隔を毎回動的に算出し、本日(JST)最後に
  投稿した時刻からその間隔以上経過していれば次の1件を投稿する。
  固定スロット（"9:00に投稿"のような）を持たないため、日中に新しい
  スタイルが自動投稿ONになったり、一部が失敗して対象件数が変わったり
  しても、次回判定時に自動で間隔が再計算される。
- `/api/cron/run-style-posts`は上記の1件版に切り替え。「手動実行」
  ボタン（`/api/automation/test-run`）は従来通り全件即時実行のまま
  （動作確認・急ぎ投稿用に維持）。
- `/style/schedule`の説明文言を更新。

### 動作確認方法
`last_executed_at`をSQLで直接操作し、「本日未投稿→即実行」
「5分前に投稿済み・残り1件→スキップ」「100分前に投稿済み→再度実行」
の3パターンを`/api/cron/run-style-posts`への実際のリクエストで確認済み
（ブラウザ起動そのものはこの環境では検証不可のため、そこで期待通り
失敗することまでを確認）。

### 「テスト実行」→「手動実行」表記変更
ユーザー要望により、ナビゲーション・ページタイトル・ボタン文言の
「テスト実行」表記をすべて「手動実行」に変更した（URLパス
`/style/test-run`・`/api/automation/test-run`・ファイル名`test-run.js`は
内部実装のため変更していない）。

## 追記（2026-08-09、実機テスト＋実HTML調査に基づく重大バグ修正）

Cloudflareへの実デプロイ後、ユーザーが実際にサロンボード連携をテストし、
「既存スタイル取り込みでNavigation timeout of 30000 ms exceeded」が発生。
原因調査のため、ユーザーのローカルPCでPlaywright(非headless)を使い
実アカウントに実際にログインしてDOM調査を実施。結果は
`docs/salonboard-real-html-findings.md`に記録済み。**今後salonboard-automation.ts/
salonboard-import.tsを触る際は必ずこのファイルを先に読むこと。**

### 判明した重大な事実

1. **反映申請ボタン(`#reflectedButton`)にinline onclick属性が無い**。旧実装の
   `[onclick*="reflected("]`セレクタは常にヒットせず、反映申請のクリックが
   実質何もしていなかった。→ IDセレクタ+`element.click()`に修正済み。
2. **NG/未確認のキーワード検索は必ずfalse positiveになる**。「NG」「未確認」は
   画面上部の固定注意書き文の中にのみ出現し、実際のライブステータスとしては
   出ない。ページ全文検索方式は常にこの注意書きにヒットしてブロック扱いになる
   欠陥があった。→ `#reflectedButton`の`--disabled`クラス＋「要確認」リンクの
   有無で判定する方式に修正済み。
3. **旧HANDOFF.md 4-3の「要確認はブロックしない」という記述は誤りだった**。
   実測で「要確認が残っているためreflectedButtonが無効化されている」ことを確認。
   要確認もブロック要因として扱うべき。
4. **dologin(event)・editStyle(event, styleId)は実際にevent引数を取る**。
   window上の関数を偽のevent引数(または引数無し)で直接呼ぶ旧実装はリスクが
   あった。→ 実際の`<a>`要素を`element.click()`する方式に修正済み。
5. **クーポンが自動投稿時に一切SALON BOARDへ送信されていなかった**
   （設計書で確定済みの隠しフィールド`frmStyleEditStyleDto.couponId`への
   セットが未実装だった）。→ 修正済み。
6. **SALON BOARDにはAkamai系のボット対策があり、headlessブラウザからの
   アクセスが弾かれる**（curlも通常設定のheadless Chromiumも弾かれ、非headless
   (実ブラウザウィンドウ)でのみ正常動作したことをローカル調査で確認）。
   Cloudflare Browser Renderingは常にheadlessで動作するため、これが
   「既存スタイル取り込みのタイムアウトが直らない」の根本原因である可能性が高い。
   → `salonboard-automation.ts`に`newAutomationPage()`を追加し、
   `navigator.webdriver`の隠蔽・User-Agent偽装・viewport設定などの
   基本的なheadless検知回避策を追加済み（全ての`browser.newPage()`呼び出しを
   これに置き換え済み）。**これでも弾かれる場合、より高度な
   フィンガープリンティング対策(Canvas/WebGL偽装等)の追加が必要になる。**

### 次にやるべきこと
1. 上記6の対策を本番デプロイ後、実際に「既存スタイル取り込み」等を再実行し、
   Akamai対策を突破できているか確認する（ユーザーへの確認待ち）。
2. 突破できていない場合、より高度なstealth対策（`puppeteer-extra-plugin-stealth`
   相当の対策をCloudflare Workers環境で実現する方法の調査、または
   Cloudflare Browser Renderingの設定オプションの見直し）を検討する。
3. スタイル一覧のページネーション（複数ページ時の「次へ」リンクの実onclick文字列）
   は未検証のまま（`docs/salonboard-real-html-findings.md`「未検証」参照）。
4. 反映申請ボタンが有効化された状態の実HTML/クラス差分は未確認のまま。

## 追記（2026-08-09 その2、isTrustedクリック対策とスタイリスト/クーポン同期ボタンの追加）

### クリックイベントのisTrusted対策（ユーザーローカルのClaude Codeと並行して対応・マージ済み）

上記6のstealth対策後も「ログインに失敗しました」エラーが発生。
`page.evaluate(() => element.click())`で発火するクリックイベントは
`event.isTrusted = false`の合成イベントになる点に着目し、Akamai等の
ボット対策JSがこれを判定材料にしている可能性を疑って対策した。

- ログインボタン・`editStyle`リンク・`#reflectedButton`のクリックを、
  すべて`page.evaluate(() => element.click())`からPuppeteerネイティブの
  `page.click(selector)`（実際のCDPレベルmouseイベント、`isTrusted: true`）
  に変更済み。
- `newAutomationPage()`のstealth対策を強化（`navigator.plugins`・
  `navigator.languages`・`window.chrome`オブジェクトの偽装を追加）。
- ログイン失敗時の診断情報（失敗時URL・画面文言先頭500文字）を
  `execution_logs`とエラーメッセージの両方に出力するようにした。
- 本番デプロイ後、この対策で実際にログインが通るかは未確認のまま
  （次にやるべきこと1・2を参照）。

### スタイリスト/コンテンツ「サロンボードと同期する」ボタンを追加（根本原因対応）

ユーザーから「画像ライブラリからスタイルの新規作成でスタイリストが
表示されない」という報告を受け調査したところ、`syncStylists()`/
`syncCoupons()`（`src/lib/salonboard-sync.ts`）は実装済みだったが、
これを呼び出すUIボタンが一度も設置されていなかったことが判明
（=DBのstylists/couponsテーブルが常に空だった）。これがスタイル作成
フォームのスタイリスト欄が常に空になる直接の原因。

- `/settings/salonboard`ページに「スタイリスト・クーポンの同期」
  セクションを追加。現在の同期件数・最終同期日時を表示し、
  「サロンボードと同期する」ボタンで手動同期できるようにした。
- 新規APIルート`POST /api/settings/sync-stylists-coupons`
  （`src/routes/dashboard.tsx`）を追加。既存のimportルートと同じ
  `launchBrowser` → `newAutomationPage` → `loginToSalonBoard` →
  （今回は）`syncStylists`/`syncCoupons`のパターンで実装。
- `salonboard-sync.ts`側の`page.goto()`も他ファイルと同様
  `networkidle0`→`domcontentloaded`＋`waitForSelector`に修正
  （このファイルだけ旧方式のまま残っていて、他箇所と同じタイムアウト
  リスクを抱えていたため）。
- フロントJSは`public/static/salonboard-sync.js`を新規作成
  （`style-import.js`と同じ構成）。

### 次にやるべきこと（更新）
5. 本番デプロイ後、`/settings/salonboard`で「サロンボードと同期する」を
   実行し、スタイリスト・クーポンが正しく取得できるか確認する
   （ここが通れば、上記のisTrusted対策・Akamai対策が実際に効いている
   ことの検証にもなる）。
6. 同期が成功したら、スタイル新規作成フォームのスタイリスト欄に
   選択肢が表示されることを確認する。

## 追記（2026-08-09 その3、ログイン成功判定バグの修正 と 連携ステータス表示の是正）

同期ボタンを実行したところ、実際には
`エラー: ログインに失敗しました [診断情報] url=https://salonboard.com/CNC/login/doLogin/ pageText="(画面テキスト取得失敗)"`
というエラーが発生。調査の結果、`loginToSalonBoard()`の成功/失敗判定
そのものにバグがあったことが判明。

### バグの内容

`dologin()`のPOST先URLは`https://salonboard.com/CNC/login/doLogin/`だが、
このURL自体に判定条件の`"/login/"`という文字列が **含まれてしまう**
（`/CNC/login/doLogin/`の`login/`部分にマッチ）。findings.md 1章に
「ログインボタンクリック後、`/CNC/login/doLogin/`へ遷移し、その後
ダッシュボード配下の画面が認証済み状態でレンダリングされる」と
記載されている通り、**このURLは正常ログイン時にも通過する中間URL**。
つまり旧ロジックは、ログインの成否に関わらず、doLogin到達直後に
チェックすると常に「失敗」と誤判定する欠陥があった
（`pageText`取得も失敗しているのは、ちょうど次の遷移が進行中で
実行コンテキストが破棄されたタイミングで評価しようとしたため
と推測される）。

### 修正内容（`src/lib/salonboard-automation.ts` `loginToSalonBoard()`）

1. URLが`/login/doLogin/`を含んでいる場合、追加でもう一段階の
   ナビゲーション完了を待つようにした（doLogin後さらに遷移する
   ケースに対応）。
2. 成功判定をURL文字列の部分一致から、**ログインフォームの入力欄
   (`input[name="userId"]`)がまだ画面に残っているかどうか**の
   DOM判定に変更した。サーバー側フォワード等でURLが変わらない
   ケースでも正しく判定できるようにするため。

### 連携ステータス表示の是正（ユーザー指摘対応）

ダッシュボードの「サロンボード連携」表示が、`salon_credentials`に
ID/パスワードが**保存されているだけ**で「連携済み」と表示していた
（実際にログインが成功したかどうかを一切見ていなかった）。
これは元々の設計書（`docs/phase3-mvp-design.md` 5-1）にあった
「接続確認」機能が実装されないまま残っていたギャップ。

- `salon_credentials.connection_status`（migration 0004で追加済みだが
  一度も書き込まれていなかったカラム）を、`loginToSalonBoard()`が
  ログインを試行するたびに`'success'`/`'failed'`で更新するようにした
  （`recordConnectionStatus()`ヘルパーを追加、`env`/`userId`を渡した
  場合のみ動作、6箇所の呼び出し元すべてに`env`/`userId`を追加）。
  失敗時は`last_error`にも診断メッセージを保存する。
- ダッシュボード（`/dashboard`）の「サロンボード連携」表示を、
  `cred`の有無ではなく`connection_status === 'success'`で判定するように
  変更。ID/Pass登録済みだが未確認/失敗の場合は「未確認/失敗」を
  amber色で表示し、「連携設定へ進む」の注意書きも出し分けるようにした。
- `/settings/salonboard`ページにも、現在の`connection_status`と
  `last_error`を表示する「連携ステータス」欄を追加。

### 次にやるべきこと（更新）
7. ✅ 上記のログイン成功判定バグ修正を本番デプロイし、「サロンボードと
   同期する」を再実行して、実際に成功するか確認する。→ 本番でスタイリスト
   同期・既存スタイル取り込み(1ページ目分)が成功することを確認済み
   (2026-08-09、ユーザー報告)。
8. ✅ 成功した場合、ダッシュボードの「サロンボード連携」表示が
   「連携済み」に切り替わることを確認する。

## 追記（2026-08-09 その4、作業分担の変更）

**サロンボード連携部分(salonboard-automation.ts / salonboard-import.ts /
salonboard-sync.ts)の実装・検証は、以降ローカルのClaude Codeが担当する。**
クラウド側セッションはこのリポジトリからサロンボード本番サイトへの
接続ができない(プロキシで`salonboard.com`への接続がブロックされる)ため、
これまでの修正はすべて`docs/salonboard-real-html-findings.md`等の
既存ドキュメントからの推測ベースだった。実際にPlaywrightでログインして
検証できるローカル側の方が、この領域については精度・速度ともに優れる
と判断し、ユーザーと合意のうえ役割分担を変更した。

- **ローカルのClaude Code担当**: サロンボード連携コードの修正・実機検証・
  デプロイ
- **クラウド側セッション担当**: それ以外の設計相談・UI実装・DB設計等

### 既知の未解決バグ(ローカル側で対応予定)

- `src/lib/salonboard-import.ts`の`fetchExistingStyles()`内、ページネーション
  処理で`window.doSelectNext()`を引数無しで呼んでいる箇所が
  `Cannot read properties of undefined (reading 'target')`エラーの原因と
  推測される(dologin/editStyle/addStyleと同様、event引数を要求する関数の
  可能性が高い)。`doSelectFirst`/`doSelectPrevious`/`doSelectLink`/
  `doSelectLast`も同様の懸念があり未検証。実際の「次へ」ボタン要素の
  実HTML構造も含めて、ローカル側での実機調査・修正が必要。
