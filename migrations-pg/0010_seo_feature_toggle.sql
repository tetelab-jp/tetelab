-- SEO機能(/seo、フリーワード対策)のサロンごとON/OFF列。新規登録サロンは
-- style_enabled/blog_enabledと同様、管理者サイト(/admin/tool)で有効化する
-- までDEFAULT 0。ただしこの列追加時点で機能は既に全サロンへ提供済みだった
-- ため、既存行は起動時IIFE側で一度だけ一括有効化する補正を行う(詳細は
-- src/index.tsx参照)。実際のマイグレーションはsrc/index.tsxの起動時IIFEで
-- 冪等に適用される。
ALTER TABLE users ADD COLUMN IF NOT EXISTS seo_enabled INTEGER NOT NULL DEFAULT 0;
