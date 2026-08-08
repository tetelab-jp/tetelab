-- ============================================
-- 0006_schedule_and_model_attrs.sql
-- ユーザーからのフィードバックに基づく変更:
--
-- 1. 自動投稿スケジュールを「オーナーが時刻・回数を選ぶ」方式から
--    「毎朝7:00から、登録済み(ready)のスタイルを順次自動投稿する
--    (1日最大100件、TETE AOUT側の運用上の上限。SALON BOARD自体の
--    上限ではない。docs/phase3-mvp-design.md 4-7参照)」方式に変更。
--    時刻・回数はもうユーザーが選べないため、該当カラムを削除する。
-- 2. モデル属性(髪量/髪質/太さ/クセ/顔型/年代)の入力欄が
--    styles/templatesのUIから抜けていたため追加対応
--    (model_attributes_jsonカラム自体は0004で追加済みだったが、
--    フォームに露出していなかった)。カラム追加は不要、UI側のみ対応。
-- ============================================

ALTER TABLE style_post_schedules DROP COLUMN times_per_day;
ALTER TABLE style_post_schedules DROP COLUMN run_times;
