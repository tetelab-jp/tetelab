-- 記事カテゴリ単位の季節パラメータ(生成テンプレートで選ぶ「1・2月」のような
-- 二月セットのチェックボックス)。実際のALTER TABLEはsrc/index.tsxの起動時
-- マイグレーションで実行される。このファイルは記録用。
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS season_months_json TEXT DEFAULT '[]';
