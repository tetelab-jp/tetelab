-- execution_logs.post_idは旧posts(廃止済み)向けのFKで、新しいblog_articlesとは
-- 別テーブルのため流用できない(実行履歴の「ブログ」タブが常に0件になる不具合の原因)。
-- 専用列を追加する。実際の適用はsrc/index.tsxの起動時マイグレーションで行われる
-- (このファイルは記録用)。
ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS blog_article_id INTEGER REFERENCES blog_articles(id) ON DELETE CASCADE;
