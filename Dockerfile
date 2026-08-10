# TETE AOUT アプリ本体(管理画面・API)。ECS Fargate常時稼働サービスとして動かす。
# スタイリスト/クーポン同期・既存スタイル取り込み機能がPuppeteerでSALON BOARDへ
# アクセスするため、投稿ワーカー(worker/)と同じくChromium同梱の公式Puppeteer
# イメージを使う。
FROM ghcr.io/puppeteer/puppeteer:25.5.0

WORKDIR /app

USER root
# 2026-08-10追記: headlessモードのChromeはSALON BOARD側のボット対策
# (Akamai系)に一貫して弾かれることが実機検証(プロキシでIPを変えても
# 症状不変)で確認できた。過去のローカル調査でも「非headless(実ブラウザ
# ウィンドウ)でのみ正常動作」という結果が出ているため、Xvfb(仮想ディス
# プレイ)を使い、実際には画面を表示しないサーバー上でも「画面あり」
# モードのChromeを起動できるようにする。
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci && chown -R pptruser:pptruser /app
USER pptruser

COPY --chown=pptruser:pptruser . .
RUN npm run build

ENV PORT=3000
EXPOSE 3000

# 2026-08-10追記: `xvfb-run`(自動ディスプレイ番号採番)がFargate環境で
# 起動に失敗/ハングし、node自体の起動(=ALBヘルスチェック応答)まで
# ブロックしてしまう不具合が発生した。Xvfbの起動をnodeの起動と分離し
# (バックグラウンドで並行起動・待ち合わせしない)、HTTPサーバーが
# Xvfbの準備を待たずに即座に応答できるようにする。DISPLAY環境変数は
# 実際にPuppeteerがブラウザを起動する時点(ユーザー操作時)までに
# Xvfbが用意されていれば良いため、この並行起動で問題ない。
# `-ac`でアクセス制御を無効化しxauth連携を不要にしている
# (コンテナ内に他プロセスがいない前提のため許容できる簡略化)。
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp & DISPLAY=:99 exec node dist/index.js"]
