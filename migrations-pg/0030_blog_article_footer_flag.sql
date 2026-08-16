-- ブログ機能再設計。記事ごとにフッターを末尾に付けるかどうかを選べるようにする。
-- 実際のALTER TABLEはsrc/index.tsxの起動時マイグレーションで実行される。
-- このファイルは記録用。

ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS footer_enabled_flag INTEGER NOT NULL DEFAULT 1;
