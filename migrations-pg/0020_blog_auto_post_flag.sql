-- 2026-08-14(ユーザー指定): スタイルのauto_post_enabled_flagと同様、記事単位で
-- 自動投稿の対象/対象外を切り替えられるようにする。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS auto_post_enabled_flag INTEGER NOT NULL DEFAULT 1;
