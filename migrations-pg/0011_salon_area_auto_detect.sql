-- フリーワード対策の対策エリア(中/小)は、SalonMotion上で手動選択するのではなく、
-- サロン自身のHPB公開ページ(https://beauty.hotpepper.jp/{hpb_sln_id}/)に掲載されている
-- 中エリア/小エリアへのリンクをそのまま読み取って自動検出する方式に変更した。
-- これに伴い、全国エリアを一括クロールして保持していたエリアマスター(ranking_areas)は
-- 不要になったため削除する。

ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS service_area_cd TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS middle_area_cd TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS middle_area_name TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS small_area_cd TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS small_area_name TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS area_synced_at TIMESTAMP;

DROP TABLE IF EXISTS ranking_areas;
