-- SEO機能(/seo)のサロンごとON/OFF列。style_enabled/blog_enabledと同様、
-- 管理者サイト(/admin/tool)で有効化するまで使わせない運用のためDEFAULT 0。
-- 実際のマイグレーションはsrc/index.tsxの起動時IIFEで冪等に適用される。
ALTER TABLE users ADD COLUMN IF NOT EXISTS seo_enabled INTEGER NOT NULL DEFAULT 0;
