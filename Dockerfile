# TETE AOUT アプリ本体(管理画面・API)。ECS Fargate常時稼働サービスとして動かす。
# スタイリスト/クーポン同期・既存スタイル取り込み機能がPuppeteerでSALON BOARDへ
# アクセスするため、投稿ワーカー(worker/)と同じくChromium同梱の公式Puppeteer
# イメージを使う。
FROM ghcr.io/puppeteer/puppeteer:25.5.0

WORKDIR /app

USER root
COPY package.json package-lock.json ./
RUN npm ci && chown -R pptruser:pptruser /app
USER pptruser

COPY --chown=pptruser:pptruser . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
