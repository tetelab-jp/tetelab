-- サロンボードへのログイン時に使うプロキシ(Bright Data)の出口IPを、
-- 毎回ランダムに変えるのではなく、直近ログイン成功時のセッションIDを
-- 優先的に使い回す(=同じ出口IPを継続利用する)ための拡張列。
-- 実際のマイグレーションはsrc/index.tsxの起動時処理(ADD COLUMN IF NOT
-- EXISTS)で自動適用されるため、このファイルは変更履歴の記録用。
ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS last_successful_proxy_session_id TEXT;
ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS last_successful_proxy_session_at TIMESTAMP;
