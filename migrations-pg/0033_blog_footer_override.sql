-- ブログのフッター(サロン基本情報から自動生成される、記事末尾に付ける文言)の
-- プレビューを直接編集できるようにするための上書き用カラム。
-- NULLまたは空文字の場合は従来通りbuildFooterText()の自動生成結果を使う。
ALTER TABLE salon_profiles ADD COLUMN footer_override_text TEXT;
