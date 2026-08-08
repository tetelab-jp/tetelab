-- ============================================
-- 0004_style_mvp_redesign.sql
-- Phase 3 MVP再設計（docs/phase3-mvp-design.md 3章に対応）
--
-- 背景: 競合3サイト分析＋実SALON BOARD画面の確認により、
-- 「店舗全体でスタイルを管理し、担当スタイリストを紐づけ、
-- SALON BOARD既存スタイルを取り込み、複数テンプレートを
-- 個別/一括適用できる」設計に作り直す。
-- 「反映申請成功」をもって自動投稿完了とする定義は変わらず。
-- ============================================

-- ---------- 3-2. salon_credentials 拡張（指示書のsalon_board_accountsに相当） ----------
ALTER TABLE salon_credentials ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE salon_credentials ADD COLUMN sync_paused_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE salon_credentials ADD COLUMN last_stylist_synced_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_coupon_synced_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_style_imported_at DATETIME;
ALTER TABLE salon_credentials ADD COLUMN last_error TEXT;

-- ---------- 3-3. blog_authors → stylists（ブログ/スタイル共通マスタ化） ----------
ALTER TABLE blog_authors RENAME TO stylists;
ALTER TABLE stylists ADD COLUMN salonboard_stylist_key TEXT; -- SALON BOARDの stylistId (T001014365形式)

-- ---------- 3-4. blog_coupons → coupons（ブログ/スタイル共通マスタ化） ----------
ALTER TABLE blog_coupons RENAME TO coupons;
ALTER TABLE coupons ADD COLUMN salonboard_coupon_key TEXT; -- SALON BOARDの couponId (CP00000010256490形式)

-- ---------- 3-5. style_post_templates → templates（複数化） ----------
-- Phase3暫定実装(1ユーザー1個のみ)。本番未使用のため破棄して作り直す。
DROP TABLE IF EXISTS style_post_templates;

CREATE TABLE templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  template_name TEXT NOT NULL,
  title_template TEXT,
  comment_template TEXT,
  category_value TEXT,               -- 'SG01' | 'SG02'
  length_value TEXT,                  -- HL01〜HL13 (docs/phase3-mvp-design.md 4-6参照)
  menu_values_json TEXT DEFAULT '[]', -- ["MC01","MC04"]
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

-- ---------- 3-6. style_images → styles(本体) + style_images(画像、子テーブル) ----------
-- 既存データを styles へ移行してから、旧 style_images を作り直す。

CREATE TABLE styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stylist_id INTEGER,
  coupon_id INTEGER,
  template_id INTEGER,

  source_type TEXT NOT NULL DEFAULT 'manual', -- manual / imported_from_salon_board
  source_salonboard_style_key TEXT,           -- 取り込み元のSALON BOARD styleId

  title TEXT,                     -- スタイル名(最大60文字、実測)
  comment TEXT,                   -- スタイリストコメント(最大240文字、実測)
  category_value TEXT,            -- 'SG01' | 'SG02'
  length_value TEXT,               -- HL01〜HL13
  menu_values_json TEXT DEFAULT '[]',   -- ["MC01","MC04"]
  menu_detail_text TEXT,          -- メニュー内容フリーテキスト(最大100文字、実測)
  hashtags_json TEXT DEFAULT '[]',
  model_attributes_json TEXT DEFAULT '{}',

  auto_post_enabled_flag INTEGER NOT NULL DEFAULT 1,
  internal_save_status TEXT NOT NULL DEFAULT 'draft',              -- draft / ready / disabled
  salonboard_register_status TEXT NOT NULL DEFAULT 'not_started',  -- not_started / success / failed
  reflection_request_status TEXT NOT NULL DEFAULT 'not_started',   -- not_started / pending / success / failed / blocked
  last_error TEXT,
  last_executed_at DATETIME,

  sort_order INTEGER NOT NULL DEFAULT 0,  -- SALON BOARD一覧の「順番」に相当
  pickup_flag INTEGER NOT NULL DEFAULT 0, -- SALON BOARD一覧の「Pick Up」に相当

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (stylist_id) REFERENCES stylists(id) ON DELETE SET NULL,
  FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);
CREATE INDEX idx_styles_user_id ON styles(user_id);
CREATE INDEX idx_styles_auto_post ON styles(user_id, auto_post_enabled_flag);

-- 既存 style_images の内容を styles へ移行(タイトル・カテゴリ程度しか持っていなかったため
-- 残りの必須項目はdraftのまま。ユーザーに編集画面での補完を促す)
INSERT INTO styles (
  id, user_id, title, category_value, auto_post_enabled_flag,
  internal_save_status, sort_order, created_at, updated_at
)
SELECT
  id, user_id, title, category,
  is_selected,
  'draft',
  sort_order, created_at, updated_at
FROM style_images;

-- sqlite_sequenceを styles 側に引き継ぎ、以後のAUTOINCREMENTが衝突しないようにする
UPDATE sqlite_sequence SET seq = (SELECT COALESCE(MAX(id), 0) FROM styles) WHERE name = 'styles';

ALTER TABLE style_images RENAME TO style_images_old;

CREATE TABLE style_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  style_id INTEGER NOT NULL,
  image_role TEXT NOT NULL DEFAULT 'FRONT', -- FRONT / SIDE / BACK (実サイト実測: FRONT+2枠)
  r2_key TEXT NOT NULL,
  file_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE
);
CREATE INDEX idx_style_images_style_id ON style_images(style_id);

-- 旧style_images(=旧styles.id と同じid体系)の画像をFRONTとして移行
INSERT INTO style_images (style_id, image_role, r2_key, file_name, sort_order, created_at)
SELECT id, 'FRONT', r2_key, file_name, 0, created_at
FROM style_images_old;

DROP TABLE style_images_old;

-- ---------- 3-7. batch_template_apply_logs (新設) ----------
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

-- ---------- 3-8. execution_logs 拡張 ----------
ALTER TABLE execution_logs ADD COLUMN style_id INTEGER REFERENCES styles(id) ON DELETE CASCADE;
ALTER TABLE execution_logs ADD COLUMN execution_type TEXT; -- register_style / request_reflection
ALTER TABLE execution_logs ADD COLUMN raw_response_text TEXT;
