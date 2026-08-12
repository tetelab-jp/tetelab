// アプリ全体で使う Bindings 型定義。
// 元はCloudflare Workers(D1Database/R2Bucket/Fetcher)のバインディング型
// だったが、AWSへの全面移行に伴い、D1/R2互換シム(src/lib/db.ts,
// src/lib/storage.ts)の型に置き換えている。ルート/ライブラリ側の
// c.env.DB / c.env.STYLE_IMAGES の呼び出し方は変わらない。
import type { PgDatabase } from './lib/db'
import type { S3Storage } from './lib/storage'

export type Bindings = {
  DB: PgDatabase
  STYLE_IMAGES: S3Storage
  JWT_SECRET?: string
  ENCRYPTION_KEY?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  CRON_SECRET?: string // 外部クロンからの /api/cron/run-style-posts 呼び出し認証用

  // ---- AWS ECS/Fargate連携(SALON BOARD投稿ワーカー) ----
  APP_BASE_URL?: string // 自身の公開URL。FargateタスクにJOB_API_BASEとして渡す
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
  ECS_CLUSTER?: string
  ECS_TASK_DEFINITION?: string
  ECS_CONTAINER_NAME?: string
  ECS_SUBNET_IDS?: string // カンマ区切り
  ECS_SECURITY_GROUP_IDS?: string // カンマ区切り

  // ---- 管理者サイト(/admin) ----
  // サロン側のJWT_SECRET/セッションCookieとは完全に分離する。
  ADMIN_JWT_SECRET?: string
  // 初期管理者アカウント(inc.tete@gmail.com)のパスワードのシード用。
  // 起動時にadmin_usersが空の場合のみ、この値をハッシュ化して1件だけ投入する
  // (コード内に平文パスワードをハードコードしないため、環境変数経由で渡す)。
  ADMIN_INITIAL_PASSWORD?: string
  // /admin/status の連続失敗検知アラート用。ARNは非機密情報のため
  // Secrets Managerではなく通常の環境変数として渡す(infra/monitoring.tfの
  // 既存SNSトピック、CloudWatchアラーム通知と同じものを使い回す)。
  SNS_ALERT_TOPIC_ARN?: string
}

export type AppUser = {
  id: number
  email: string
  salon_name: string | null
  is_active: number
  style_enabled: number
  blog_enabled: number
  seo_enabled: number
}

export type AdminUser = {
  id: number
  email: string
}
