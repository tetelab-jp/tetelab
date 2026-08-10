-- ============================================
-- 0005_template_menu_detail_text.sql
-- templatesテーブルに menu_detail_text が抜けていたため追加。
-- style.tsx のテンプレートフォームは styles と同じ
-- 「メニュー内容フリーテキスト（最大100文字）」を保存する想定だが、
-- 0004でstylesにのみ追加され、templatesへの追加が漏れていた。
-- ============================================

ALTER TABLE templates ADD COLUMN menu_detail_text TEXT;
