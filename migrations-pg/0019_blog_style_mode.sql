-- 2026-08-14(ユーザー指定): 「これまでのブログの書き方に寄せる」チェックボックス
-- (mimic_past_tone)は、実際には何も参照していなかったため撤廃する。
--
-- 代わりに、カテゴリ(blog_categories)単位で「文章スタイル」を選べるようにする:
--   scraped   : サロンボードの過去ブログ記事を参照する(未実装。当面はparamsと同じ)
--   reference : サロン基本情報に入力した参考文章(salon_profiles.reference_text)を参照する
--   params    : 一人称・語尾・文体などのパラメータのみを使用する(デフォルト)
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーションで行われる。
-- このファイルはスキーマ変更の記録用。

ALTER TABLE salon_profiles ADD COLUMN IF NOT EXISTS reference_text TEXT;
ALTER TABLE salon_profiles DROP COLUMN IF EXISTS mimic_past_tone;
ALTER TABLE blog_categories ADD COLUMN IF NOT EXISTS style_mode TEXT NOT NULL DEFAULT 'params';
