-- 複数サロンアカウント対応: サロンボードの1ログインに複数サロン(ヘア/キレイ)が
-- 紐づくケースで、どのサロンを使うか確定できるようにする。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS target_store_id TEXT;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS salon_type TEXT;
