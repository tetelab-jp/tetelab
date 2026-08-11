-- 実行履歴(style_post_runs)一覧のステータスが、各ジョブの結果を集計せず
-- 常に'processing'のまま表示され続ける不具合の修正用。
-- どのジョブがどの実行(run)に属するかを記録し、そのrunに属する全ジョブが
-- 完了した時点でstyle_post_runs.statusを確定させられるようにする。
-- 実際のマイグレーションはsrc/index.tsxの起動時処理(ADD COLUMN IF NOT
-- EXISTS)で自動適用されるため、このファイルは変更履歴の記録用。
ALTER TABLE style_post_jobs ADD COLUMN IF NOT EXISTS run_id INTEGER REFERENCES style_post_runs(id) ON DELETE SET NULL;
