import build from '@hono/vite-build/node'
import devServer from '@hono/vite-dev-server'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build({
      port: Number(process.env.PORT) || 3000,
      staticRoot: './public',
      // staticPathsは指定しなくてもpublic/配下のディレクトリを自動検出して
      // 登録される(@hono/vite-build/nodeの標準動作)。
      // pg/puppeteer/aws-sdkはネイティブ依存・実行時のファイルシステム相対
      // 参照(pgのオプショナルpg-native require、puppeteerの同梱Chromium
      // パス解決等)を含むため、バンドルせずnode_modules経由でrequireさせる。
      // Dockerイメージにはnpm ciでnode_modulesを含めるため実行時に解決できる。
      external: ['pg', 'pg-native', 'puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth', '@aws-sdk/client-s3', '@hono/node-server', '@hono/node-server/serve-static']
    }),
    devServer({
      entry: 'src/index.tsx'
    })
  ]
})
