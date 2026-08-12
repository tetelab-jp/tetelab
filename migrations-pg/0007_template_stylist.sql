-- テンプレート作成・適用画面にも担当スタイリスト欄を追加するための拡張列。
-- 実際のマイグレーションはsrc/index.tsxの起動時IIFEで冪等に適用される。

ALTER TABLE templates ADD COLUMN IF NOT EXISTS stylist_id INTEGER REFERENCES stylists(id) ON DELETE SET NULL;
