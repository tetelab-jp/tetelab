-- 記録用。実際の適用はsrc/index.tsxの起動時マイグレーションで行う(ALTER TABLE ADD COLUMN IF NOT EXISTS方式)。
--
-- ブログ「サロンの人格」(来てくれる人・価格帯)のAI生成材料が不足していたため、
-- HPB公開ページの「サロンボードから読み込む」取得範囲に平均予約金額・来店者の
-- 性別/年代比率を追加する。

ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_avg_price_first TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_avg_price_repeat TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_customer_ratio TEXT;
