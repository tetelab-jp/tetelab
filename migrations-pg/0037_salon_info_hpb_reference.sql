-- 記録用マイグレーション(実適用は src/index.tsx の起動時マイグレーションで行う)。
-- 「サロン情報」機能: HPB公開ページの「〜の雰囲気」「〜のサロンデータ」
-- 「特集」「こだわり」「スタイリスト個別プロフィール」を、既存の
-- hpb_catch/hpb_copy/hpb_message等と同じくAI記事生成の参考材料として追加する。

ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_atmosphere_text TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_salon_data_text TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_specials_text TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_kodawari_text TEXT;

ALTER TABLE stylists ADD COLUMN IF NOT EXISTS hpb_bio_text TEXT;
