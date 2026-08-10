# SALON BOARDスタイル投稿ジョブを1回実行して終了するワーカー。
# 公式Puppeteerイメージを使い、Chromiumと実行に必要な共有ライブラリの
# 個別インストールを避ける(apt依存の管理コストを減らすため)。
FROM ghcr.io/puppeteer/puppeteer:25.5.0

WORKDIR /app

# 公式イメージは既定で非rootユーザー(pptruser)。/appの所有権を合わせる。
USER root
# 2026-08-10追記: 本体アプリ(../Dockerfile)と同じ理由でXvfb(仮想ディスプレイ)
# を導入し、headlessではなく「画面あり」モードのChromeを起動できるようにする。
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*
# 2026-08-10追記: 本体アプリ(../Dockerfile)と同じ理由(pptruser非rootでの
# Xvfb起動が/tmp/.X11-unix作成に失敗する不具合)で、root権限のあるこの時点で
# 正しい権限(1777)で先に作成しておく。
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
COPY package.json package-lock.json ./
RUN npm ci \
    && chown -R pptruser:pptruser /app
USER pptruser

COPY --chown=pptruser:pptruser tsconfig.json ./
COPY --chown=pptruser:pptruser src ./src
RUN npm run build

# 2026-08-10追記: `xvfb-run`(自動ディスプレイ番号採番)がFargate環境で
# 起動に失敗/ハングする不具合が発生したため、固定ディスプレイ番号で
# バックグラウンド起動し、ソケット出現を最大5秒待ってから(タイムアウトしても
# 諦めてそのまま続行)node本体を起動する方式に変更した。`-ac`でアクセス制御を
# 無効化しxauth連携を不要にしている。
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp & for i in $(seq 1 25); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.2; done; DISPLAY=:99 exec node dist/index.js"]
