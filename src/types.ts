// Cloudflare Workers バインディング型定義
export type Bindings = {
  DB: D1Database
  STYLE_IMAGES: R2Bucket
  JWT_SECRET?: string
  ENCRYPTION_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
}

export type AppUser = {
  id: number
  email: string
  salon_name: string | null
}
