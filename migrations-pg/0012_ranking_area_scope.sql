-- 順位測定は毎回、中エリア(小エリアで絞り込まない検索)と小エリア(絞り込みあり)の
-- 両方を別々に計測するようにしたため、どちらの計測結果かを区別する列を追加する。
-- 既存行は旧仕様(小エリアありきの単一計測)だったため既定値'small'とする。

ALTER TABLE ranking_results ADD COLUMN IF NOT EXISTS area_scope TEXT NOT NULL DEFAULT 'small';
