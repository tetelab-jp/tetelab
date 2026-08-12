# フリーワード対策（SEO順位計測）— 完全引き継ぎドキュメント

このドキュメント1つで、別の Claude Code が本機能の**全作業を引き継げる**ことを目的とした単一の情報源です。
（元のセッションは以後作業しません。以降の実装・検証・保守はこのドキュメントを起点に進めてください。）

- 対象リポジトリ: `tetelab-jp/tetelab`（SalonMotion / 本番 `https://salonmotion.com`）
- 作成時点の `main`: `a1b1ac7`（PR #78・#82 マージ済み）
- 機能の公開URL: `https://salonmotion.com/seo` 配下

---

## 0. 30秒サマリ

- HPB（ホットペッパービューティー）の**公開検索ページ**をスクレイピングして、自サロンの
  フリーワード検索**掲載順位**を計測する機能「フリーワード対策」を追加した。
- 画面は3つ：**対策キーワード設定**（登録）/ **順位測定**（測定＋履歴＋前回比較）/ **定期測定設定**（cron）。
- ルートは `/seo` 配下。DBは `ranking_*` テーブル＋`salonboard_salons`。スキーマは**起動時に自動作成**。
- サロンボード連携でサロン名・サロンID（STORE_ID）も取得して保存済み。
- **機能本体は実装・マージ・デプロイ済み**。残りは主に「本番実測の検証」「terraform apply」「admin表示管理との連携」。

---

## 1. 現在の状態（重要）

| PR | 内容 | 状態 |
|---|---|---|
| #78 | フリーワード対策 機能本体 | **マージ済み・デプロイ済み**（Run #77 成功） |
| #82 | サロン名/ID同期 ＋ URLを `/ranking`→`/seo` に変更 | **マージ済み・デプロイ済み/中**（Run #84） |

- ブランチ `claude/hpb-automation-new-feature-jctna8` は、以後の作業では**使い回さず**、
  **最新 `main` から切り直す**こと（旧履歴はsquashマージ済み）。
- **デプロイ = `main` へのpush**（`.github/workflows/deploy-app.yml` が起動）。デプロイ制限は解除済み。

---

## 2. 画面・ルート（全一覧）

ナビ: `src/components/layout.tsx` の `NAV_ITEMS` / `NAV_GROUPS`。グループ表示名「フリーワード対策」（group key = `ranking`）。

| 画面 | ルート | NavKey | 役割 |
|---|---|---|---|
| 対策キーワード設定 | `GET /seo/keywords` | `ranking-keywords` | 登録の場。サロン名・大/中/小エリア・キーワード(最大10)入力→**登録名モーダル**で保存。下に登録済み一覧（名前/編集リンク→編集画面） |
| 順位測定 | `GET /seo` | `ranking-measure` | 登録テンプレを**複数選択**→**「測定」**。下に**1測定=1コンテナ**でログ（ヘッダー: サロン名+エリア+日時、本文: キーワード毎の順位）。過去分表示＋**同一キーワードの前回比**を ▲▼ バッジ |
| 定期測定設定 | `GET /seo/schedule` | `ranking-schedule` | 有効/頻度(毎日・毎週)/実行時刻(JST) ＋ **全国エリア一括取得**ボタン ＋ 前回実行時刻表示 |

その他エンドポイント（すべて `src/routes/ranking.tsx`）:
- `POST /seo/measure`（JSON `{queryIds:[]}`）… 選択テンプレをバックグラウンド測定
- `POST /seo/templates`（作成）/ `GET /seo/templates/:id/edit` / `POST /seo/templates/:id`（更新）/ `POST /seo/templates/:id/delete`
- `GET /seo/api/areas?level=middle|small&service=&middle=` … カスケード用JSON
- `POST /seo/areas/refresh` … 全国エリア一括クロール（バックグラウンド）
- `POST /api/cron/run-ranking` … 定期測定cron（Bearer `CRON_SECRET`、セッション不要）
  - ※ユーザー向けは `/seo` だが、cronは `infra/eventbridge.tf` と整合のため `/api/cron/run-ranking` のまま。

---

## 3. ファイル構成

**追加（順位計測コア）**
- `src/routes/ranking.tsx` … 全ルート（`/seo` 配下）＋バックグラウンド測定 `runTemplates()`／定期 `runScheduledForUser()`。
- `src/lib/ranking-url.ts` … 検索結果URL組み立て（純粋関数）。
- `src/lib/ranking-parse.ts` … 結果HTMLパース（順位/該当数、エリア抽出。cheerio・純粋関数）。
- `src/lib/ranking-scraper.ts` … fetch＋ページ送り＋プロキシ対応、エリアクロール。
- `src/lib/ranking-areas.ts` … 大エリア静的定義＋中/小のオンデマンド/一括クロール＋サロン名選択肢。
- `public/static/ranking.js` … カスケード・測定・登録モーダル・エリア一括取得のクライアント処理。
- `migrations-pg/0005_ranking.sql` … スキーマ正本。

**既存への追記（最小限）**
- `src/index.tsx` … `ranking` を dashboard/style/blog より前に mount／起動時DDLに順位計測テーブル追加／`RANKING_PROXY_URL` バインディング。
- `src/types.ts` … `RANKING_PROXY_URL?`。
- `src/components/layout.tsx` … ナビ「フリーワード対策」グループ。
- `src/lib/salonboard-sync.ts` … サロン名/ID同期関数（#82）。
- `src/routes/dashboard.tsx` … 同期処理でサロン情報取得を呼び出し（#82）。
- `infra/eventbridge.tf` … 定期測定cronのスケジュール。
- `.github/workflows/deploy-app.yml` … appデプロイの `concurrency`（多重デプロイ直列化）。

---

## 4. DBスキーマ（`migrations-pg/0005_ranking.sql`）と自動適用

**適用方式**: 専用ランナーが無いため、`src/index.tsx` の起動時ブロックが `CREATE TABLE IF NOT EXISTS`
で**自動適用**（既存 0002〜0004 と同じ運用）。**手動SQL不要**。採番は 0002_proxy/0003/0004 と衝突しない 0005。

- `salonboard_salons(user_id, salon_key, salon_name, hpb_sln_id, ...)` … サロン名同期の受け皿（#82で投入）。
- `ranking_areas(level[1/2/3], service_area_cd, middle_area_cd, small_area_cd, name, url, parent_id, sort_order)` … エリアマスター。
- `ranking_queries(user_id, name, salon_name, service_area_cd, middle_area_cd, small_area_cd, area_label, is_active, ...)` … 登録テンプレ。`name`=登録名。
- `ranking_query_keywords(query_id, keyword, sort_order)` … テンプレのキーワード（最大10）。
- `ranking_runs(user_id, trigger['manual'|'scheduled'], status['running'|'done'|'error'], started_at, finished_at)` … 1回の測定。
- `ranking_results(user_id, run_id, query_id, salon_name, area_label, service/middle/small_area_cd, keyword, rank, result_count, pages_scanned, matched_sln_id, status, measured_at)` … 結果（`rank=NULL`=圏外）。
- `ranking_schedules(user_id UNIQUE, enabled, frequency['daily'|'weekly'], run_time'HH:MM', last_run_at, ...)` … 定期測定設定。

---

## 5. スクレイピング設計（詳細）

**検索結果URL**（直接組み立て。ブラウザ自動化不要）:
```
https://beauty.hotpepper.jp/CSP/bt/salonSearch/search/
  ?serviceAreaCd=SA&middleAreaCd=JR&smallAreaCd=X566
  &freeword=<kw>&searchGender=ALL&sortType=popular&fromSearchCondition=true&pn=<page>
```

**エリアコード対応**:
- 大エリア = `serviceAreaCd`（パス `svc{XX}` の接尾辞）。全9地域を `ranking-areas.ts` に静的保持:
  SA=関東, SB=関西, SC=東海, SD=北海道, SE=東北, SH=北信越, SF=中国, SI=四国, SG=九州・沖縄。
- 中エリア = `middleAreaCd`（`mac{YY}`）。大エリアページ `svc{XX}/` の `a[href="/svc{XX}/mac{YY}/"]` から抽出（名前の `<br>` は空白化）。
- 小エリア = `smallAreaCd`（`X...`）。中エリアページの `a.jscAreaConditionLink`（`id` が `X` 始まり）から抽出。
  「エリア変更」モーダル（`#conditionAreaChangeTarget` / `.jscConditionModal`）内は除外。

**順位抽出**:
- サロン枠: `h3.slnName > a`（ヘア）/ 無ければ `h3.slcHead > a`（エステ等）。該当数: `.numberOfResult`。1ページ20件。
- **PR/広告枠（href に `cstt` を持たない枠）はスキップ**して**オーガニック順位**を算出（Python版のズレを修正）。
- サロン照合: **サロン名の正規化部分一致**（NFKC＋記号除去）。各結果に `slnH...` を `matched_sln_id` として記録。

**プロキシ**: HPBがデータセンターIPを弾く場合に備え `RANKING_PROXY_URL`（任意）で undici ProxyAgent 経由。未設定は直アクセス。

**検証状況**: パーサ・エリア抽出はユーザー提供の実HTMLで確認済み。**HPBへの実アクセスは開発サンドボックスから不可のため、実測は本番デプロイ後**。

---

## 6. サロン名/サロンID 同期（#82）

サロンボード同期（スタイリスト/クーポン）の**ログイン直後**に、ヘッダーから取得して `salonboard_salons` へupsert。
- サロン名: `<li class="shop_login_name">…</li>`
- サロンID: `<input type="hidden" name="STORE_ID" value="H000750928">`
- `hpb_sln_id` に `'sln'+STORE_ID`（例 `slnH000750928`）を保存。HPB公開ページ `/slnH000750928/` および
  順位結果の `slnH...` と一致 → **将来のID完全一致照合**に利用可能。

実装:
- `src/lib/salonboard-sync.ts`: `fetchSalonInfoFromSalonBoard()` / `upsertSalonInfo()` / `syncSalonInfo()`。
- `src/routes/dashboard.tsx`: `POST /api/settings/sync-stylists-coupons` のログイン直後に `syncSalonInfo()`。

これで「対策キーワード設定」のサロン名ドロップダウンが同期データで埋まる。未同期時は `users.salon_name` にフォールバック（`getSalonOptions()`）。
※ `salonboard-automation.ts` 本体は未改変。

---

## 7. 定期測定 cron

- `POST /api/cron/run-ranking`（Bearer `CRON_SECRET`）: `enabled` かつ「今日/今週まだ未実行」かつ `run_time` を過ぎた
  ユーザーの**有効な全テンプレ**をバックグラウンド測定。`ranking_schedules.last_run_at` で二重起動防止。
- `infra/eventbridge.tf`: 既存cron接続（Bearer認証）を流用し `/api/cron/run-ranking` を**5分間隔**で叩く
  `aws_cloudwatch_event_rule` + `event_target` を追加。**本番反映には `terraform apply` が必要**。

---

## 8. mount順・認証（`src/index.tsx`）

- `ranking` は `dashboard/style/blog`（各々 `.use('*', requireAuth)`）**より前**に mount。理由: `/api/cron/run-ranking`
  がセッション不要（Bearerのみ）で到達する必要があるため（`automation` と同じ理由）。
- `ranking` 自体はブランケット `.use('*')` を持たず、認証必須ページは各ルートで `requireAuth`。

---

## 9. 環境変数・インフラ

- `RANKING_PROXY_URL`（任意）: HPB到達にプロキシが要る場合に設定（ECSタスク定義の環境変数 or Secrets Manager）。
- `infra/eventbridge.tf`: 定期測定cronのスケジュール（`terraform apply` で反映）。
- `.github/workflows/deploy-app.yml`: `concurrency: deploy-app`（app多重デプロイを直列化・済）。

---

## 10. デプロイ／CI／マージのワークフロー

- **デプロイ = `main` へのpush**（`deploy-app.yml`。Dockerビルド→ECR→ECSタスク更新→サービス安定待ち）。
  トリガ paths は `src/** public/** migrations-pg/** package*.json vite.config.ts tsconfig.json Dockerfile deploy-app.yml`。
  → **`docs/**` や `infra/**` はデプロイ対象外**（infraは `terraform apply` で反映）。
- PRでは**CIが走らない**（ワークフローは push:main のみ）。マージ可否は差分レビューで判断。
- 複数セッションが同一リポを触るため、**マージ前に必ず最新mainを取り込む**。
- マージ方式は **squash**（既存PRの慣習）。
- **衝突しやすい箇所**: `src/index.tsx` の起動時DDLブロック／import・mount列、`layout.tsx` の `NAV_ITEMS`/`NAV_GROUPS`、
  `migrations-pg/` の採番（次は 0006 以降）、`salonboard_salons` 契約、`deploy-app.yml`。
- **開発サンドボックスからは HPB（beauty.hotpepper.jp）に到達不可**（ネットワークポリシー）。パーサ等は提供HTMLで検証、実測は本番。

---

## 11. デプロイ後の本番セットアップ・検証手順

1. `main` マージ → 自動デプロイ（テーブルは起動時自動作成）。
2. `infra/eventbridge.tf` を **`terraform apply`**（定期測定cronのスケジュール作成）。
3. 本番appから `beauty.hotpepper.jp` へ到達できるか確認。弾かれる場合は **`RANKING_PROXY_URL`** を設定。
4. 「定期測定設定」ページの**「全国エリアを一括取得」**を1回実行（数分。全国の中/小を `ranking_areas` へ投入）。
5. サロンボード連携設定でスタイリスト/クーポン同期を実行 → 「対策キーワード設定」のサロン名ドロップダウンに実サロン名が出るか確認。
6. 動作確認: 「対策キーワード設定」で登録 →「順位測定」で測定 → ログ表示。

---

## 12. 残タスク（引き継ぎ先が次にやること・優先度順）

1. **[必須] 本番実測の検証**: HPB到達性、`/seo` 表示、エリア一括取得、実際の順位取得が正しいか。
   - 弾かれる → `RANKING_PROXY_URL` 設定（既存の Bright Data 等）。
   - 取得ズレ → セレクタ（`.slnName`/`.numberOfResult`/`cstt`）や検索URLパラメータを実データで微調整。
2. **[必須] `terraform apply`**（eventbridge cron）。実施しないと定期測定は動かない。
3. **[要確認] サロン名/ID同期の実機確認**: ログイン直後ページで `li.shop_login_name` / `input[name=STORE_ID]` が
   実際に取れるか。取れない場合は取得タイミング/対象ページを調整（`syncSalonInfo` の呼び出し位置）。
4. **[連携] 管理者サイトの「項目表示管理」対応**（下記 13章）。`/admin/tool` 実装時に `/seo` を登録・既定ON。
5. **[任意] ID一致照合への拡張**: `salonboard_salons.hpb_sln_id`（`slnH...`）を `ranking_queries` に持たせ、
   結果の `matched_sln_id` と**完全一致**で照合（同名・表記ゆれ対策で精度向上）。現状はサロン名部分一致。
6. **[任意] UI微調整**: 必要に応じて（エリア名の `<br>` 空白化・前回比バッジ等は対応済み）。

---

## 13. 他機能との連携：管理者サイト（`/admin`）の「項目表示管理」

- 現状 `main` の `/admin`（#80）は**基盤のみ**（ログイン+認証ガード、`/admin/salons` はプレースホルダ、
  `/admin/tool`・`/admin/status` は認証ガードのみでGET未実装）。
- **サロン側ナビ（`NAV_ITEMS`）は静的で、admin による表示フィルタは未実装**。よって現時点では
  `/seo` は**全サロンに常時表示**され、adminの影響を受けない（＝今すぐ隠れる心配はない）。
- **今後 `/admin/tool` で「サロンごとの機能(ナビ項目)表示ON/OFF」を実装する場合**、
  **「フリーワード対策 / `/seo`」を管理対象ツールとして登録し、既定で表示ON**にしないと隠れてしまう。
  実装方針の例: `NAV_ITEMS` の各項目に「ツールキー」を持たせ、`PageLayout`（Sidebar）が**可視ツール一覧を
  受け取ってフィルタ表示**する。表示管理のデータモデル（`tool_visibility` テーブル、ツールキー一覧、サロン単位フラグ）を
  確定させてから、順位計測側のナビ項目（`ranking-keywords`/`ranking-measure`/`ranking-schedule`）を登録すること。

---

## 14. 設計判断の背景（なぜ）

- **fetch+cheerio（ブラウザ不要）**: 検索結果URLが規則的に組み立てられると判明したため。Puppeteer/Fargateを回避し軽量化。
- **PR枠除外（cstt基準）**: HPBは広告枠を差し込むため、DOM順ではオーガニック順位がズレる。`cstt` を持つ枠だけ数える。
- **起動時DDL自動適用**: 専用マイグレーションランナーが無く、main側が同方式を採用済みのため踏襲（手動SQL不要）。
- **`/api/cron/run-ranking` はパス据え置き**: `/seo` 化してもcronパスを変えると `eventbridge.tf` の再applyが必要になるため。
- **サロン名は同期優先＋`users.salon_name`フォールバック**: サロンボードのサロン名がHPB掲載名と一致し照合精度が高いため。

---

## 15. 既知のリスク・未検証事項

- HPB到達性（本番AWS IPが弾かれる可能性）→ 未検証。`RANKING_PROXY_URL` で対応可能。
- 検索結果ページ（`/CSP/bt/salonSearch/search/`）のDOMは、提供された**ブラウズページ**HTMLで代替検証。テンプレ差異があれば微調整要。
- 小エリアパネルがSSRかJS描画か未確認（JS描画だとcheerioで拾えない → 取得元URL調整要）。
- 同期のサロン名/ID取得は、ログイン直後ページにヘッダーが出る前提。実機で要確認。
- 測定はバックグラウンド（常駐Nodeサーバー前提）。多数キーワード×多ページで時間がかかる（最大50ページ）。

---

## 16. 参考（元セッションのコミット群 / マージ済み）

`b99bb15`→…→`358b6c5`（#78 として squash）／サロン同期・`/seo`化（#82 として squash `a1b1ac7`）。
関連PR: **#78・#82**（いずれもマージ済み）。管理者サイト基盤は **#80**（別担当）。
