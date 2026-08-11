-- ============================================
-- 0002_ranking.sql (PostgreSQL / 追加マイグレーション)
--
-- 「検索順位計測」機能で使うテーブル群。0001_init.sql は編集せず追加で持つ。
-- 既存の流儀に合わせる:
--   - SERIAL PRIMARY KEY / user_id で全行をスコープ / ON DELETE CASCADE
--   - 真偽値フラグは INTEGER(0/1)。アプリ側が === 1 / ? 1 : 0 で扱う
--   - 時刻は TIMESTAMP(UTCの "YYYY-MM-DD HH:MM:SS" 文字列前提。db.tsで接続TZ=UTC固定)
--
-- ※適用はこのリポジトリの既存運用どおり手動でRDSへ流す想定。
-- ============================================

-- --------------------------------------------
-- (連携用の契約テーブル)
-- サロンボードから同期したサロン名。実際の同期処理(サロンボードのスクレイピング)
-- は salonboard-automation 側(別担当)で追加され、このテーブルへ UPSERT する想定。
-- ranking機能は「計測」画面のサロン名ドロップダウンの選択肢としてここを読み、
-- 未投入の間は users.salon_name にフォールバックする(消費側のみ本PRで実装)。
-- --------------------------------------------
CREATE TABLE salonboard_salons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salon_key TEXT,              -- サロンボード上の識別子(任意)
  salon_name TEXT NOT NULL,    -- 表示名 兼 検索結果照合キー
  hpb_sln_id TEXT,             -- 将来のID一致用 slnH...(任意)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_salonboard_salons_user_id ON salonboard_salons(user_id);

-- --------------------------------------------
-- HPBエリア階層マスター(クローラで投入)。大(1)/中(2)/小(3)を parent_id で連結。
-- 検索URLの serviceAreaCd / middleAreaCd / smallAreaCd に対応する。
-- --------------------------------------------
CREATE TABLE ranking_areas (
  id SERIAL PRIMARY KEY,
  level INTEGER NOT NULL,          -- 1=大エリア, 2=中エリア, 3=小エリア
  service_area_cd TEXT NOT NULL,   -- 大エリアCd 例 'SA'(関東)
  middle_area_cd TEXT,             -- 中エリアCd 例 'BC'
  small_area_cd TEXT,              -- 小エリアCd
  name TEXT NOT NULL,              -- 表示名 例 '関東' / '赤羽・王子・十条'
  url TEXT,                        -- 取得元URL(参考・デバッグ用)
  parent_id INTEGER REFERENCES ranking_areas(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ranking_areas_parent ON ranking_areas(parent_id);
CREATE INDEX idx_ranking_areas_level ON ranking_areas(level);

-- --------------------------------------------
-- 登録済みの計測条件(「計測情報登録設定」で管理)。1条件 = サロン × エリア。
-- 「計測」画面で「登録」ボタンを押すと作成される。
-- --------------------------------------------
CREATE TABLE ranking_queries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,                     -- 計測テンプレート名(管理用)
  salon_name TEXT NOT NULL,
  service_area_cd TEXT NOT NULL,
  middle_area_cd TEXT,
  small_area_cd TEXT,
  area_label TEXT,               -- 表示用ラベル 例「関東 > 赤羽・王子・十条」
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ranking_queries_user_id ON ranking_queries(user_id);

-- 条件に紐づくキーワード(画面の最大10枠。1条件に複数)
CREATE TABLE ranking_query_keywords (
  id SERIAL PRIMARY KEY,
  query_id INTEGER NOT NULL REFERENCES ranking_queries(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ranking_query_keywords_query_id ON ranking_query_keywords(query_id);

-- --------------------------------------------
-- 計測の1回の実行(手動/定期)。キーワード毎の結果を束ねる。
-- --------------------------------------------
CREATE TABLE ranking_runs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'scheduled'
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'error'
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP
);
CREATE INDEX idx_ranking_runs_user_id ON ranking_runs(user_id);

-- --------------------------------------------
-- 計測結果(キーワード毎に1行 = 「計測」画面下部の履歴テーブルの各行)。
-- query_id は登録条件からの計測なら紐づく。使い捨て計測(登録せず計測)は NULL。
-- --------------------------------------------
CREATE TABLE ranking_results (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id INTEGER REFERENCES ranking_runs(id) ON DELETE CASCADE,
  query_id INTEGER REFERENCES ranking_queries(id) ON DELETE SET NULL,
  salon_name TEXT NOT NULL,
  area_label TEXT,
  service_area_cd TEXT NOT NULL,
  middle_area_cd TEXT,
  small_area_cd TEXT,
  keyword TEXT NOT NULL,
  rank INTEGER,                 -- NULL = 圏外
  result_count INTEGER,         -- 該当数(.numberOfResult)
  pages_scanned INTEGER,        -- 走査したページ数
  matched_sln_id TEXT,          -- 一致した slnH...(記録用)
  status TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'not_found' | 'error'
  error_message TEXT,
  measured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ranking_results_user_id ON ranking_results(user_id);
CREATE INDEX idx_ranking_results_query_id ON ranking_results(query_id);
CREATE INDEX idx_ranking_results_user_measured ON ranking_results(user_id, measured_at);

-- --------------------------------------------
-- 定期測定設定(「定期測定設定」画面)。ユーザー単位1件。
-- 実行は既存の CRON_SECRET + /api/cron/... パターンを踏襲する想定。
-- --------------------------------------------
CREATE TABLE ranking_schedules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL DEFAULT 'daily', -- 'daily' | 'weekly'
  run_time TEXT,                           -- 'HH:MM'(JST想定)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
