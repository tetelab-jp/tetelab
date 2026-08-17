-- 記録用。実際の適用はsrc/index.tsxの起動時マイグレーションで行う(CREATE TABLE IF NOT EXISTS方式)。
--
-- ブログ「サロンボードから読み込む」を拡張し、HPB公開ページから
-- キャッチ・コピー・からの一言(メッセージ)と、過去のブログ記事(最大100件、
-- 一覧ページの抜粋のみ・全文は取得しない)を取得してAI生成の参考材料にする。
-- 廃止する文章スタイル選択ドロップダウン(style_mode/reference_text/scraped)の
-- 置き換え。

ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_catch TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_copy TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_message TEXT;

CREATE TABLE IF NOT EXISTS blog_reference_articles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_id INTEGER NOT NULL REFERENCES salonboard_salons(id) ON DELETE CASCADE,
  title TEXT,
  excerpt TEXT NOT NULL,
  source_url TEXT NOT NULL,
  posted_date DATE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_blog_reference_articles_salon ON blog_reference_articles(salon_id, sort_order);
