-- 複数サロンワークスペース対応: UNIQUE(user_id) → UNIQUE(salon_id) 差替。
--
-- salon_profiles / style_post_schedules / ranking_schedules は元々
-- 「1 user_id = 1行」前提のUNIQUE(user_id)制約を持っていた。2サロン目を
-- 有効化しても、アプリ側の(user_id, salon_id)存在チェック後のINSERTが
-- この制約に阻まれて失敗する(2サロン目のプロフィール/スケジュール保存が
-- 常に失敗するバグ)ため、0022の salon_id バックフィル完了後にこの制約を
-- 「1物理サロン(ワークスペース)につき1行」を表すUNIQUE(salon_id)へ
-- 差し替える。
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーションで行われる(0022の
-- salon_idバックフィルより後に実行される必要があるため、同一トランザクション
-- ではなく別のtry/catchブロックとして順序を保証している)。このファイルは
-- スキーマ変更の記録用。

ALTER TABLE salon_profiles DROP CONSTRAINT IF EXISTS salon_profiles_user_id_key;
ALTER TABLE salon_profiles ADD CONSTRAINT salon_profiles_salon_id_key UNIQUE (salon_id);

ALTER TABLE style_post_schedules DROP CONSTRAINT IF EXISTS style_post_schedules_user_id_key;
ALTER TABLE style_post_schedules ADD CONSTRAINT style_post_schedules_salon_id_key UNIQUE (salon_id);

ALTER TABLE ranking_schedules DROP CONSTRAINT IF EXISTS ranking_schedules_user_id_key;
ALTER TABLE ranking_schedules ADD CONSTRAINT ranking_schedules_salon_id_key UNIQUE (salon_id);
