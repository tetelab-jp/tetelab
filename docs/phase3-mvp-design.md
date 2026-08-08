# Phase 3 MVP設計書 — SALON BOARD スタイル投稿自動化

> 元になった指示書（2026-08-08、ユーザー提供）を、TETE AOUTの既存実装（`migrations/0001`〜`0003`、
> `src/routes/style.tsx`、`src/lib/salonboard-automation.ts`等）と突き合わせて具体化したもの。
> 「保存完了」ではなく「SALON BOARD上での反映申請成功」をもって自動投稿完了とする、という
> 定義を踏襲する。

## 0. 既存実装との差分サマリ（最重要）

今回の指示書は、現在の実装から見ると以下の点で設計変更を伴う。

| 項目 | 現状（Phase 2〜3暫定） | 今回の指示書 |
|---|---|---|
| テンプレート | 1ユーザー1個のみ（`style_post_templates.user_id UNIQUE`） | 複数作成・名前付き・個別/一括適用 |
| スタイリスト | `blog_authors`（ブログ用に手入力） | `stylists`としてSALON BOARDから同期、スタイルにも紐付け |
| クーポン | `blog_coupons`（ブログ専用、手入力） | SALON BOARDから同期する共通マスタ、スタイルにも紐付け |
| スタイル画像 | `style_images` 1行=1画像=1投稿単位 | `styles`（本体）+ `style_images`（画像、FRONT/SIDE/BACK等の子テーブル） |
| 既存スタイル | 取り込み機能なし | SALON BOARD掲載済みスタイルの取り込みが必須機能 |
| 状態 | `style_post_runs.status`（pending/processing/done/failed）のみ | 自社状態・登録状態・反映申請状態の3階層に分離 |
| 一括操作 | なし | 100件単位でのテンプレート一括適用 |

なお、**「店舗全体で管理する」という要件と、既存のアーキテクチャ決定「1ユーザー=1サロン
（`salon_id`設計は不採用）」（HANDOFF.md セクション3・9）は矛盾しない**。指示書内の`salon_id`は
すべて既存の`user_id`と1:1で読み替える。新規`salons`テーブルは作らない（`users`テーブルが
実質的にそれを兼ねているため、二重管理を避ける）。

---

## 1. MVP画面一覧

既存ルートを再設計・拡張する形で実装する（新規ページは最小限に絞る）。

| # | 画面 | 対応ルート | 種別 |
|---|---|---|---|
| 1 | 接続設定画面 | `/settings/salonboard`（拡張） | 既存拡張 |
| 2 | スタイル一覧画面 | `/style/library`（再設計） | 既存再設計 |
| 3 | スタイル作成/編集画面 | `/style/:id/edit`（新規）＋`/style/new`（新規） | 新規 |
| 4 | テンプレート管理画面 | `/style/template`（複数対応に再設計） | 既存再設計 |
| 5 | 既存スタイル取り込みモーダル | `/style/library` 内モーダル、API: `/api/style/import` | 新規（モーダル） |
| 6 | 一括テンプレート適用モーダル | `/style/library` 内モーダル、API: `/api/style/bulk-apply-template` | 新規（モーダル） |
| 7 | 実行履歴/エラー確認画面 | `/style/test-run`（汎用実行履歴画面に格上げ） | 既存再設計 |

画面数を増やさないため、5・6は独立ページではなくモーダルとして`/style/library`に統合する。

---

## 2. 画面ごとの責務

### 2-1. 接続設定画面（`/settings/salonboard`）
- SALON BOARD ID/パスワードの登録・更新（既存の`encryptSecret()`をそのまま利用）
- 接続確認ボタン（ログインのみ試行し、即ログアウトする軽量チェック処理を新設）
- 最終同期日時（スタイリスト/クーポン別）、同期停止トグルの表示
- エラー欄（`salon_board_accounts.last_error`を表示）

### 2-2. スタイル一覧画面（`/style/library`）
- 店舗全体のスタイルを100件単位ページングで一覧表示
- 列: サムネイル／スタイル名／担当スタイリスト／クーポン／テンプレート適用状態／
  自動投稿対象フラグ／自社保存状態／SALON BOARD登録状態／反映申請状態／最終実行日時
- 複数選択チェックボックス→「一括テンプレート適用」ボタンを活性化
- 「取り込みボタン」→取り込みモーダルを開く
- 検索・絞り込みは任意（MVPでは担当スタイリスト・状態でのフィルタ程度に留める）

### 2-3. スタイル作成/編集画面（`/style/new`, `/style/:id/edit`）
- テンプレート選択（選択すると各項目に初期値を流し込む。個別上書き可）
- 担当スタイリスト選択、画像（複数枚・役割指定）、スタイル名、コメント、カテゴリ、長さ、
  メニュー内容、クーポン、ハッシュタグ、モデル属性、自動投稿対象フラグ
- バリデーションは実サロンボードの実測上限に合わせる（後述4章参照）
- 保存＝`internal_save_status`を`draft`/`ready`に更新するのみ。SALON BOARDへの反映は行わない

### 2-4. テンプレート管理画面（`/style/template`）
- テンプレート一覧（名前・カテゴリ・停止フラグ）＋新規作成／編集
- 各テンプレートは「コメント雛形・スタイル名雛形・カテゴリ/長さ/メニュー/クーポン/
  ハッシュタグ/モデル属性の初期値」を保持

### 2-5. 既存スタイル取り込みモーダル
- SALON BOARDの「スタイル掲載情報一覧」から取得した一覧を表示（サムネイル・スタイル名・担当）
- チェックボックスで選択→「取り込む」
- 画像だけでなくテキスト属性（4-4参照）も可能な限り取得

### 2-6. 一括テンプレート適用モーダル
- 対象件数表示（最大100件）
- テンプレート選択→実行→結果表示（成功件数/失敗件数）
- **MVPでは「テンプレートを選んで適用する」の一操作のみ**。個別項目の直接一括編集はしない

### 2-7. 実行履歴/エラー確認画面（`/style/test-run`）
- スタイル名／実行種別（登録・反映申請）／結果／エラー理由／実行日時／再実行可否
- `failed`/`blocked`のみに絞るフィルタ

---

## 3. データモデル定義

既存テーブルへの **EXTEND**（列追加）・**RENAME**（改名）・**NEW**（新設）・**REPLACE**（作り直し）を明記する。
実装は`migrations/0004_style_mvp_redesign.sql`として1本にまとめる想定。

### 3-1. `users` — 変更なし
既存のまま。指示書の`salons`はこのテーブルを指す。

### 3-2. `salon_credentials` → **EXTEND**（指示書の`salon_board_accounts`に相当）
```sql
ALTER TABLE salon_credentials ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'not_started';
  -- not_started / success / failed
ALTER TABLE salon_credentials ADD COLUMN sync_paused_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE salon_credentials ADD COLUMN last_stylist_synced_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_coupon_synced_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_style_imported_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_error TEXT;
```
新規テーブルを作らず既存を拡張する（1ユーザー1行の設計と完全に一致するため）。

### 3-3. `blog_authors` → **RENAME + EXTEND** → `stylists`
```sql
ALTER TABLE blog_authors RENAME TO stylists;
ALTER TABLE stylists ADD COLUMN salonboard_stylist_key TEXT;
  -- SALON BOARDの#stylistCheckCd <option value> に相当。同期時に埋める
```
ブログ・スタイル両方で同じスタイリストマスタを共有する（現状ブログ側は手入力だったが、
今後はSALON BOARD同期に統一できる）。`src/routes/blog.tsx`の`blog_authors`参照箇所を
`stylists`に置き換える必要がある（影響範囲: blog.tsx, dashboard.tsx）。

### 3-4. `blog_coupons` → **RENAME + EXTEND** → `coupons`
```sql
ALTER TABLE blog_coupons RENAME TO coupons;
ALTER TABLE coupons ADD COLUMN salonboard_coupon_key TEXT;
```
同様にスタイル・ブログ共通のクーポンマスタとして統一する。`blog.tsx`側の参照名を追従修正。

### 3-5. `style_post_templates` → **REPLACE**（1人1個→複数化）
```sql
DROP TABLE style_post_templates; -- Phase3暫定実装。本番未使用のため破棄して作り直す

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_name TEXT NOT NULL,
  title_template TEXT,               -- スタイル名の雛形
  comment_template TEXT,             -- スタイリストコメントの雛形（最大120文字、4-4参照）
  category_value TEXT,               -- 'SG01' | 'SG02'
  length_value TEXT,
  menu_values_json TEXT DEFAULT '[]',
  coupon_id INTEGER,
  hashtags_json TEXT DEFAULT '[]',
  model_attributes_json TEXT DEFAULT '{}',
  active_flag INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL
);
CREATE INDEX idx_templates_user_id ON templates(user_id);
```

### 3-6. `style_images` → **REPLACE**（本体と画像を分離）
現行の`style_images`（1行1画像1投稿単位）を、`styles`（本体）＋`style_images`（画像、子テーブル）
に分割する。既存データは`styles`へ移行し、`style_images`は`role='FRONT'`の1行として作り直す。

```sql
CREATE TABLE styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stylist_id INTEGER,
  coupon_id INTEGER,
  template_id INTEGER,

  source_type TEXT NOT NULL DEFAULT 'manual', -- manual / imported_from_salon_board
  source_salonboard_style_key TEXT,           -- 取り込み元のSALON BOARD内部ID（styleId）

  title TEXT,                     -- スタイル名（最大30文字、実測値）
  comment TEXT,                   -- スタイリストコメント（最大120文字、実測値）
  category_value TEXT,            -- 'SG01' | 'SG02'
  length_value TEXT,
  menu_values_json TEXT DEFAULT '[]',   -- パーマ/ストレートパーマ・縮毛矯正/エクステ/ブリーチ
  menu_detail_text TEXT,          -- メニュー内容フリーテキスト（最大50文字、実測値）
  hashtags_json TEXT DEFAULT '[]',      -- 最大20個（実測値）
  model_attributes_json TEXT DEFAULT '{}', -- 髪量/髪質/太さ/クセ/顔型/年代

  auto_post_enabled_flag INTEGER NOT NULL DEFAULT 1,
  internal_save_status TEXT NOT NULL DEFAULT 'draft',        -- draft / ready / disabled
  salonboard_register_status TEXT NOT NULL DEFAULT 'not_started', -- not_started / success / failed
  reflection_request_status TEXT NOT NULL DEFAULT 'not_started',  -- not_started / pending / success / failed / blocked
  last_error TEXT,
  last_executed_at DATETIME,

  sort_order INTEGER NOT NULL DEFAULT 0,  -- SALON BOARD一覧の「順番」に相当（実測項目）
  pickup_flag INTEGER NOT NULL DEFAULT 0, -- SALON BOARD一覧の「Pick Up」に相当（実測項目）

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (stylist_id) REFERENCES stylists(id) ON DELETE SET NULL,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);
CREATE INDEX idx_styles_user_id ON styles(user_id);
CREATE INDEX idx_styles_auto_post ON styles(user_id, auto_post_enabled_flag);

CREATE TABLE style_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id INTEGER NOT NULL,
  image_role TEXT NOT NULL DEFAULT 'FRONT', -- FRONT / SIDE / BACK（実サイト実測：FRONT+2枠）
  r2_key TEXT NOT NULL,
  file_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE
);
CREATE INDEX idx_style_images_style_id ON style_images(style_id);
```

`pickup_flag`と一覧の`sort_order`（編集可能な「順番」）は今回スクリーンショットで実在が
確認できた項目のため、MVPのデータ構造には含めるが、**SALON BOARD側への書き込み操作
（自動でPick Upを設定する等）はMVP対象外**とする（7章参照）。

### 3-7. `batch_template_apply_logs` — **NEW**
```sql
CREATE TABLE batch_template_apply_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_id INTEGER NOT NULL,
  applied_count INTEGER NOT NULL DEFAULT 0,
  target_style_ids_json TEXT NOT NULL,
  result_status TEXT NOT NULL,   -- success / partial / failed
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE
);
```

### 3-8. `execution_logs` → **EXTEND**
既存の汎用ログテーブルを流用し、スタイル実行用途の列を追加する（`posts`との紐付けは
そのまま残し、`style_id`を新設して両対応にする）。
```sql
ALTER TABLE execution_logs ADD COLUMN style_id INTEGER REFERENCES styles(id) ON DELETE CASCADE;
ALTER TABLE execution_logs ADD COLUMN execution_type TEXT; -- register_style / request_reflection
ALTER TABLE execution_logs ADD COLUMN raw_response_text TEXT;
```
`status`列（既存: success/failure）はそのまま`result_status`として使う。

### 3-9. `style_post_runs` / `style_post_schedules` — 変更なし
1日N回・チェック済みスタイルをまとめて実行する「実行バッチ」の枠組みとして引き続き使う。
対象抽出条件のみ`style_images.is_selected`から`styles.auto_post_enabled_flag`に読み替える。

---

## 4. 状態管理定義

指示書どおり3階層に分離する（`styles`テーブルの3列にそれぞれ対応）。

### 4-1. 自社側状態（`internal_save_status`）
| 値 | 意味 |
|---|---|
| `draft` | 編集途中・必須項目未充足 |
| `ready` | 投稿実行可能（必須項目充足済み） |
| `disabled` | 利用停止・自動投稿対象外 |

### 4-2. SALON BOARD登録状態（`salonboard_register_status`）
| 値 | 意味 |
|---|---|
| `not_started` | 未実行 |
| `success` | スタイル登録（doRegister）成功 |
| `failed` | 登録失敗 |

### 4-3. 反映申請状態（`reflection_request_status`）
| 値 | 意味 |
|---|---|
| `not_started` | 未実行 |
| `pending` | 登録成功、反映申請待ち |
| `success` | 反映申請成功＝**自動投稿完了** |
| `failed` | 反映申請失敗 |
| `blocked` | 「要確認」以外のNG・掲載チェック等でボタンが押せない状態 |

### 4-4. 状態遷移の原則
- `internal_save_status = ready`だけでは完了扱いにしない
- `salonboard_register_status = success`だけでも完了扱いにしない
- `reflection_request_status = success`になって初めて「自動投稿完了」
- `blocked`になった場合は必ず`last_error`に原因を残す
- 実サロンボードの実測仕様（HANDOFF.md 4-3参照）：「要確認」は反映申請をブロックしない。
  ブロックするのは「NG」または「未確認」が残っている場合のみ。この判定ロジックを
  `submitReflectApplication()`実行前のチェックとして実装する。

### 4-5. フィールド上限値（実測・確定）
今回のスクリーンショットで実測できた値。バリデーションはこれに合わせる。

| フィールド | 上限 | 出典 |
|---|---|---|
| スタイル名 | 30文字 | スタイル編集画面実測 |
| スタイリストコメント | 120文字 | スタイル編集画面実測（115/120表示） |
| メニュー内容（フリーテキスト） | 50文字 | スタイル編集画面実測（49/50表示） |
| ハッシュタグ | 20個 | スタイル編集画面実測（0/20表示） |

---

## 5. 処理フロー

指示書の7章をベースに、実装対象モジュール（`src/lib/salonboard-automation.ts`,
`src/lib/style-post-runner.ts`）と対応付ける。

### 5-1. 初期設定フロー
1. サインアップ（既存: `src/routes/auth.tsx`）
2. `/settings/salonboard`でSALON BOARD ID/パスワード登録（既存の`encryptSecret()`利用）
3. 「接続確認」ボタン→新設`checkSalonBoardConnection()`（ログインのみ試行しすぐ終了、
   `connection_status`を更新）
4. 「スタイリスト同期」「クーポン同期」ボタン→新設`syncStylists()`/`syncCoupons()`
   （SALON BOARDの該当ページをスクレイピングし`stylists`/`coupons`へupsert）

### 5-2. 既存スタイル取り込みフロー
1. 新設`fetchExistingStyles(page)`：スタイル一覧ページ（複数ページ、実測150件/2ページ構成
   ※HANDOFF.md記載の件数と、指示書の「100件単位」はUI表示の話であり、SALON BOARD側の
   総件数上限とは別物として扱う）を巡回し、一覧情報を取得
2. 取り込みモーダルでユーザーが選択
3. 選択された各スタイルについて、新設`fetchStyleDetail(page, styleId)`で編集画面を開き
   詳細項目（画像・スタイル名・コメント・カテゴリ・長さ・メニュー・クーポン・
   ハッシュタグ・モデル属性）を取得
4. 画像はダウンロードしR2にアップロードし直す（`style_images`へ格納）
5. `styles`へ`source_type='imported_from_salon_board'`で保存
6. `internal_save_status='ready'`をデフォルトとする（取り込み済み＝入力完了しているため）

### 5-3. 新規スタイル作成フロー
既存の`/style/library`アップロードUIを`/style/new`に再設計。テンプレート選択時は
`templates`の値をフォーム初期値に流し込む（JS側でクライアント処理、サーバー往復なし）。

### 5-4. 一括テンプレート適用フロー
1. `/style/library`で複数選択→「一括テンプレート適用」
2. `POST /api/style/bulk-apply-template` に`styleIds`(最大100件)・`templateId`
3. サーバー側で対象`styles`行をテンプレート値で一括UPDATE（画像・担当スタイリストは
   変更しない。指示書通りテンプレート項目のみ反映）
4. `batch_template_apply_logs`に結果を記録

### 5-5. 投稿実行フロー（`postStyleImageFull`を拡張）
既存の`draftRegisterStyle()`＋`submitReflectApplication()`を土台に、状態遷移を追加する。
```
runStyleAutomationForUser() [style-post-runner.ts]
  → 対象: internal_save_status='ready' AND auto_post_enabled_flag=1
  → for each style:
      1. draftRegisterStyle() 実行
         成功 → salonboard_register_status='success', reflection_request_status='pending'
         失敗 → salonboard_register_status='failed', execution_logs記録, 次のスタイルへ
      2. 掲載管理TOPで「NG」「未確認」の有無を確認する新設 checkReflectBlockers(page)
         ブロック要因あり → reflection_request_status='blocked', last_error保存
      3. submitReflectApplication() 実行
         成功 → reflection_request_status='success'
         失敗 → reflection_request_status='failed'
      4. execution_logsに register_style / request_reflection それぞれ記録
```

### 5-6. 再実行フロー
`/style/test-run`（実行履歴画面）で`failed`/`blocked`を一覧表示し、「再実行」ボタンから
該当スタイル単体のみ5-5を再実行するAPI（`POST /api/style/:id/retry`、新設）を呼ぶ。

---

## 6. 実装優先順位

**2026-08-08 更新**：ユーザー指示により、スタイリスト/クーポンは「手入力→後で同期に置き換え」
ではなく「最初からSALON BOARDへの自動取得（同期）機能を作り、その結果を共通リストとして
ブログ・スタイル投稿の両方で使い回す」方針に変更。手入力UIを先に作って後から差し替える
二度手間を避けるため、同期機能を前倒しする。

| Phase | 内容 | ライブサイト検証要否 |
|---|---|---|
| 3-A | `migrations/0004`でデータモデル移行（3章。`stylists`/`coupons`統合を含む） | 不要 |
| 3-B | スタイリスト/クーポン同期（`syncStylists`/`syncCoupons`）＋接続設定画面（同期状態・エラー表示） | 要（マスタページのHTML/DOM確認） |
| 3-C | スタイル一覧・作成/編集画面の再設計（担当スタイリスト紐付け、状態列表示） | 不要 |
| 3-D | テンプレート管理の複数化＋個別適用・一括適用モーダル | 不要 |
| 3-E | 実行履歴画面の汎用化（3状態表示、再実行ボタン） | 不要 |
| 3-F | 既存スタイル取り込み（`fetchExistingStyles`/`fetchStyleDetail`） | 要 |
| 3-G | 投稿実行フローへの状態遷移組み込み・NG/未確認判定 | 要 |
| 3-H | 写真アップロードの実装検証（HANDOFF.md記載の最大の難所） | 要（最優先で実サイト確認） |

3-Bを前倒ししたことで、実装着手には**「スタイリスト一覧」「クーポン一覧」ページ
（掲載管理タブ内、サロンボード上部ナビの「スタイリスト」「クーポン」）のHTML**も
早い段階で必要になる。9章の依頼ページ一覧に追加した。

3-C〜3-Eはテスト用SALON BOARDアカウントが無くても進められるため、3-Bと並行して着手できる。
3-F以降は、テスト用アカウントでの実地確認（DevTools Networkタブでの実際のリクエスト確認）
が前提になる。

---

## 7. MVPに入れない機能

- 一括での個別項目直接編集（タイトル・タグ・クーポンの個別一括変更） — 指示書で明示的に対象外
- スタイリスト単位の管理画面・ログイン（サロンパラダイス型） — 「店舗全体管理」の方針と非両立のため不採用
- 口コミへのAI返信生成（スタイルポスト型） — 今回のスコープはスタイル投稿のみ。将来的な拡張候補として6-4的な位置づけで別途検討
- ブログの「既存投稿取り込み」 — 今回はスタイルのみ対象
- 動画スタイル対応 — 既存同様「画像」形式固定
- SALON BOARD側の「非掲載にする」「削除する」「Pick Up」ボタンの自動操作 — データとしては保持する（3-6参照）が、書き込み操作の自動化はMVP対象外
- ヘアスタイル特集・画像応募チェックの自動設定 — フィールド自体が期間限定キャンペーン依存のため対象外のまま

---

## 8. 拡張しやすい設計上の注意点

- `menu_values_json`/`hashtags_json`/`model_attributes_json`をJSON列にしているため、
  SALON BOARD側にフィールドが追加されてもマイグレーション無しで対応できる
- `execution_logs.execution_type`を文字列にしているため、将来`request_blog_post`等の
  種別を追加する際もスキーマ変更不要
- `coupons`/`stylists`をブログ・スタイルで共有マスタ化したことで、将来「クーポン一括
  差し替え」「スタイリスト単位の実績集計」等を追加しやすい
- `batch_template_apply_logs`は`target_style_ids_json`を残しているため、将来
  「一括削除」「一括クーポン差し替え」等、テンプレート適用以外の一括操作ログにも
  流用できる形にしてある（`operation_type`列を追加するだけで拡張可能）
- `styles.source_type`により「手動作成」と「取り込み」を区別しているため、将来
  取り込み専用のバリデーション緩和（例: 取り込み直後は必須項目チェックをスキップする等）
  も追加しやすい

---

## 9. 未確定・要確認事項（実装前に解消が必要）

1. **画像アップロードの実際の内部動作**（最重要・HANDOFF.md既知の課題）：
   スクリーンショットでは「画像をアップロードする」という直接的なボタン表示だったが、
   クリック時にモーダルが開くのか、直接ファイル選択ダイアログが開くのかは未確認。
   実際にテスト用アカウントでクリックし、DevTools Networkタブでアップロードの
   実リクエストを確認する必要がある。
2. **スタイル一覧・編集画面の実際のHTML（フォームのid/name属性等）**：
   スクリーンショットは見た目の確認はできたが、Puppeteer実装に必要なセレクタ
   （`document.getElementById(...)`等で使う実際の属性値）はHTMLソースでないと分からない。
   可能であれば、対象ページで右クリック→「ページのソースを表示」または
   ブラウザのDevTools→Elementsタブの内容を保存して共有いただけると、
   実装の手戻りを減らせる。
3. **クーポン選択のUI**：チップ形式で表示されていたが、選択自体がモーダル経由か
   セレクトボックスかは未確認（HANDOFF.md 4-5にも同様の指摘あり）。
4. **スタイリスト一覧／クーポン一覧ページのHTML**（6章の優先順位変更により追加）：
   `syncStylists()`/`syncCoupons()`実装のため、掲載管理タブ内の「スタイリスト」
   「クーポン」ページのHTMLソースも必要。ユーザーからHTML提供予定の
   「スタイル一覧」「スタイル編集」「ログイン画面」に加えて依頼する。
