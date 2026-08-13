-- ブログ自動投稿機能 大幅リニューアル(2026-08-14、Phase 1)
-- 3ページ構成(/blog/salon, /blog/template, /blog/articles)+記事確認モーダルへの
-- 全面刷新に伴うスキーマ変更。実際の適用はsrc/index.tsxの起動時マイグレーション
-- (ALTER/CREATE ... IF NOT EXISTS)で行われる。このファイルはスキーマ変更の記録用。

-- salon_profiles: サロン基本情報(フッター差し込み用)・人格・書き方・フッター設定を追加
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS nearest_station TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS walk_minutes TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS business_hours TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS closing_days TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS strengths TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS price_range TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS mimic_past_tone INTEGER NOT NULL DEFAULT 1;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS first_person TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS sentence_ending TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS emoji_style TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS footer_separator TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS footer_keywords_json TEXT DEFAULT '[]';
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS salonboard_synced_at TIMESTAMP;

-- blog_categories: HPBカテゴリ・デフォルト投稿者・伝えたいこと・生成プロンプトを追加
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS hpb_category_value TEXT;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS default_stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS key_message TEXT;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS title_prompt TEXT;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS body_prompt TEXT;

-- blog_articles: 新設。汎用のpostsテーブルは画像・承認・カテゴリ関連のFKが無く
-- 後付けするより新設した方が素直なため、styles/style_imagesと同じ設計方針で作る。
CREATE TABLE IF NOT EXISTS blog_articles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES blog_categories(id) ON DELETE SET NULL,
  image_r2_key TEXT,
  image_file_name TEXT,
  image_description TEXT,
  title TEXT,
  body TEXT,
  coupon_id INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL,
  month_tags_json TEXT DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_generation',
  last_error TEXT,
  approved_at TIMESTAMP,
  last_posted_at TIMESTAMP,
  post_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_articles_user_id ON blog_articles(user_id);
CREATE INDEX IF NOT EXISTS idx_blog_articles_category_id ON blog_articles(category_id);
CREATE INDEX IF NOT EXISTS idx_blog_articles_user_status ON blog_articles(user_id, status);
