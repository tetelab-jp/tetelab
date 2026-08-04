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
- **フロントエンド**: JSXサーバーレンダリング(`hono/jsx-renderer`) + TailwindCSS(CDN)
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
