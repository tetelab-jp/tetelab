# cron-trigger-worker

Cloudflare Pages は Cron Trigger（`scheduled()`）をサポートしないため、本体アプリ
（`../`）とは別に、この最小限のCloudflare Workerが1分おきに起動し、本体アプリの
`/api/cron/run-style-posts` を叩く役割だけを担う。

## セットアップ

```bash
cd cron-trigger-worker
npm install

# 本体アプリのデプロイ後URLに書き換える
# wrangler.jsonc の vars.TARGET_URL を編集

# 本体アプリ側と同じ値でシークレットを設定
npx wrangler secret put CRON_SECRET

npm run deploy
```

## 動作確認

```bash
npm run dev
# 別タブで
curl http://localhost:8787/
```

`fetch()`ハンドラでも同じ処理を手動実行できるようにしてあるので、実際にCronで
動かす前に疎通確認ができる。
