// Cloudflare Workers バインディング型定義
export type Bindings = {
  DB: D1Database
  JWT_SECRET?: string
  ENCRYPTION_KEY?: string
}

export type AppUser = {
  id: number
  email: string
  salon_name: string | null
}
