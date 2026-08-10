# SALON BOARDスタイル投稿ジョブを1回実行して終了するワーカー。
# 公式Puppeteerイメージを使い、Chromiumと実行に必要な共有ライブラリの
# 個別インストールを避ける(apt依存の管理コストを減らすため)。
FROM ghcr.io/puppeteer/puppeteer:25.5.0

WORKDIR /app

# 公式イメージは既定で非rootユーザー(pptruser)。/appの所有権を合わせる。
USER root
COPY package.json package-lock.json ./
RUN npm ci \
    && chown -R pptruser:pptruser /app
USER pptruser

COPY --chown=pptruser:pptruser tsconfig.json ./
COPY --chown=pptruser:pptruser src ./src
RUN npm run build

CMD ["node", "dist/index.js"]
