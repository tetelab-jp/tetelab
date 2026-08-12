-- 同一プロキシセッション(出口IP)でのネットワーク障害の連続回数を記録する列。
-- 1回の障害だけではセッションを切り替えず、2回連続で発生した場合のみ
-- 「このセッションは壊れている」とみなして切り替える判定に使う
-- (実績のない新しいIPは画像認証(CAPTCHA)に当たりやすいため)。
-- 実際のマイグレーションはsrc/index.tsxの起動時IIFEで冪等に適用される。

ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS proxy_session_fail_count INTEGER DEFAULT 0;
