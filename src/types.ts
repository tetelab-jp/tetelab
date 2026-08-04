// Cloudflare Workers バインディング型定義
export type Bindings = {
  DB: D1Database
  STYLE_IMAGES: R2Bucket
  BROWSER: Fetcher // Cloudflare Browser Rendering (@cloudflare/puppeteer)
  JWT_SECRET?: string
  ENCRYPTION_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  CRON_SECRET?: string // 外部クロンからの /api/cron/run-style-posts 呼び出し認証用
}

export type AppUser = {
  id: number
  email: string
  salon_name: string | null
}
