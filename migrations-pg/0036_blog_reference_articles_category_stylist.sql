-- HPB公開ブログ一覧の各記事に掲載されているカテゴリ・投稿者(スタイリスト)を
-- 保存し、登録ブログへ取り込む際にblog_articles.category_id/stylist_idへ
-- 反映できるようにする。実際のALTER TABLEはsrc/index.tsxの起動時マイグレーションで
-- 実行される。このファイルは記録用。

ALTER TABLE blog_reference_articles ADD COLUMN IF NOT EXISTS category_name TEXT;
ALTER TABLE blog_reference_articles ADD COLUMN IF NOT EXISTS stylist_name TEXT;
ALTER TABLE blog_reference_articles ADD COLUMN IF NOT EXISTS stylist_salonboard_key TEXT;
