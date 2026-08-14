-- 複数サロンワークスペース対応 フェーズ0: スキーマ土台。
--
-- 「追加契約すれば複数サロンをこのアプリで使え、サロン切り替えボタンで
-- スタイル・クーポン・スタイリスト・ブログ・順位測定等のデータを完全に
-- 別々に切り替えられる」機能のための土台。既存のsalonboard_salons
-- (1ユーザーにつき複数行を許容するサロン一覧テーブル)を「サロンワーク
-- スペース」の主エンティティに昇格させ、業務データ全テーブルにsalon_id
-- を追加する。
--
-- 実際の適用(列追加+既存データのバックフィル)はsrc/index.tsxの起動時
-- マイグレーションで行われる。このファイルはスキーマ変更の記録用。
-- バックフィル処理の詳細もsrc/index.tsx側のコメント参照。

ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_slot_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS is_active_workspace INTEGER NOT NULL DEFAULT 0;
ALTER TABLE salonboard_salons ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE SET NULL;

-- 業務データ全テーブルへ salon_id (nullable) を追加。NOT NULL化は
-- バックフィル完了確認後の別デプロイで行う(このマイグレーションでは行わない)。
ALTER TABLE styles ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE stylists ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE batch_template_apply_logs ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE style_post_schedules ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE style_post_runs ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE blog_articles ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE ranking_queries ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE ranking_runs ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE ranking_results ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
ALTER TABLE ranking_schedules ADD COLUMN IF NOT EXISTS salon_id INTEGER REFERENCES salonboard_salons(id) ON DELETE CASCADE;
