-- 記録用マイグレーション(実適用は src/index.tsx の起動時マイグレーションで行う)。
-- 「サロン情報」機能のクーポン部分: HPB公開のクーポン・メニューページから
-- 「クーポン内容」(couponDescription)を取得し、既存のcouponsマスタへ追加保存する。

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS hpb_description_text TEXT;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS hpb_coupons_text TEXT;
