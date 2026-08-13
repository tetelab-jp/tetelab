-- NATゲートウェイの固定IP直接接続をプロキシより優先して試す3段階リトライ
-- 方針(2026-08-13、ユーザー提案):
-- ・投稿の候補セッションは先頭3件をNATゲートウェイの固定IP直接接続
--   (プロキシ不使用、worker/src/salonboard-automation.tsのDIRECT_SESSION_ID)
--   にする
-- ・3回連続で固定IP経由の投稿が完了できなかった場合、残りの候補は
--   従来通りDataImpulseのプロキシセッションにフォールバックする
-- ・フォールバックが発生した場合、5時間は固定IPを候補から外し
--   (direct_ip_cooldown_until)、プロキシ候補のみを使う
-- ・固定IPで投稿が成功した場合は、残っていたクールダウンを解除する
--
-- 実際の適用はsrc/index.tsxの起動時マイグレーション(ALTER TABLE ... IF NOT
-- EXISTS)で行われる。このファイルはスキーマ変更の記録用。

ALTER TABLE salon_credentials ADD COLUMN IF NOT EXISTS direct_ip_cooldown_until TIMESTAMP;
