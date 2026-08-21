-- 記録用マイグレーション(実適用は src/index.tsx の起動時マイグレーションで行う)。
-- 口コミ返信フォームの「返信者」欄(SALON BOARD側のreplyFrom、HOT PEPPER
-- Beauty上には非表示の内部メモ欄)。ジョブ単位で実際に投稿した値を記録する。

ALTER TABLE review_reply_jobs ADD COLUMN IF NOT EXISTS reply_from TEXT;
