-- 口コミ設定ページ(/reviews/settings)向けの追加設定。実際のALTER TABLEは
-- src/index.tsxの起動時マイグレーションで実行される。このファイルは記録用。
--
-- ・must_include_text: 返信文章に必ず入れること(フリー入力。AIへの生成指示に使う)
-- ・must_avoid_text: 返信文章に絶対にしてはいけないこと(フリー入力。AIへの生成指示に使う)
-- ・append_salon_name_flag/append_salon_name_text: サロン名を返信文章最後に追加する
--   ON/OFFと、追加するサロン名テキスト(SEOキーワードを含めたサロン名を想定)。
--   AI生成後に機械的に追加する(AI任せだと付け忘れ・表記ゆれが起きるため)。

ALTER TABLE review_reply_schedules ADD COLUMN IF NOT EXISTS must_include_text TEXT;
ALTER TABLE review_reply_schedules ADD COLUMN IF NOT EXISTS must_avoid_text TEXT;
ALTER TABLE review_reply_schedules ADD COLUMN IF NOT EXISTS append_salon_name_flag INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_reply_schedules ADD COLUMN IF NOT EXISTS append_salon_name_text TEXT;
