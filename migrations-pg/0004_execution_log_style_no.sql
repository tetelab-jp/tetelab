-- 実行履歴(個別実行ログ)に表示する「No.」を、登録スタイル一覧の並び順の
-- スナップショットとして記録するための拡張列。並び順(sort_order)は
-- 後から変更されうるため、実行時点のNo.を保存しておかないと、後で並びが
-- 変わった際に過去の実行履歴のNo.が現在の並びに引きずられて変わってしまう。
-- 実際のマイグレーションはsrc/index.tsxの起動時処理(ADD COLUMN IF NOT
-- EXISTS)で自動適用されるため、このファイルは変更履歴の記録用。
ALTER TABLE execution_logs ADD COLUMN IF NOT EXISTS style_no INTEGER;
