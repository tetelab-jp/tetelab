-- 新規登録サロンは、管理者サイト(/admin/tool)で有効化するまでスタイル/
-- ブログの自動投稿機能を使わせない運用に変更。実際のマイグレーションは
-- src/index.tsxの起動時IIFEで冪等に適用される(既存行の値は変更しない)。
ALTER TABLE users ALTER COLUMN style_enabled SET DEFAULT 0;
ALTER TABLE users ALTER COLUMN blog_enabled SET DEFAULT 0;
