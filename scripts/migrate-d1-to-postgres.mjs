#!/usr/bin/env node
// ============================================
// migrate-d1-to-postgres.mjs
//
// Cloudflare D1(本番)の全データを、AWS RDS PostgreSQL(migrations-pg/0001_init.sql
// 適用済みであること)へ移行する。外部キー依存順にテーブルを処理し、id列も
// そのままINSERTした上で、各テーブルのSERIALシーケンスをMAX(id)+1に合わせ直す。
//
// 実行前提:
//   - `wrangler login` 済み、またはCLOUDFLARE_API_TOKEN環境変数が設定済み
//   - RDS側に migrations-pg/0001_init.sql が適用済み(テーブルが空の状態)
//
// 実行方法:
//   DATABASE_URL="postgres://user:pass@host:5432/dbname" node scripts/migrate-d1-to-postgres.mjs
// ============================================

import { execSync } from 'node:child_process'
import { Pool } from 'pg'

const D1_DATABASE_NAME = 'hotpepper-automation-production'

// 外部キー依存順(親テーブルが先)。migrations-pg/0001_init.sqlの定義順と一致させている。
const TABLES = [
  'users',
  'salon_credentials',
  'blog_categories',
  'coupons',
  'salon_profiles',
  'stylists',
  'templates',
  'styles',
  'style_images',
  'posts',
  'execution_logs',
  'batch_template_apply_logs',
  'style_post_schedules',
  'style_post_runs',
  'style_post_jobs'
]

function fetchD1Table(table) {
  const json = execSync(
    `npx wrangler d1 execute ${D1_DATABASE_NAME} --remote --json --command "SELECT * FROM ${table}"`,
    { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 200 }
  )
  const parsed = JSON.parse(json)
  return parsed?.[0]?.results ?? []
}

async function migrateTable(pool, table) {
  const rows = fetchD1Table(table)
  if (rows.length === 0) {
    console.log(`[${table}] 0件(スキップ)`)
    return
  }

  const columns = Object.keys(rows[0])
  const columnList = columns.map((c) => `"${c}"`).join(', ')

  for (const row of rows) {
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
    const values = columns.map((c) => row[c])
    await pool.query(
      `INSERT INTO ${table} (${columnList}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
      values
    )
  }

  // SERIAL(id)のシーケンスをMAX(id)+1に合わせ直す(移行後の新規INSERTがぶつからないように)
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
  )

  console.log(`[${table}] ${rows.length}件 移行完了`)
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('環境変数 DATABASE_URL が必要です(RDSへの接続文字列)')

  const pool = new Pool({ connectionString: databaseUrl, options: '-c TimeZone=UTC' })

  try {
    for (const table of TABLES) {
      await migrateTable(pool, table)
    }
    console.log('すべてのテーブルの移行が完了しました')
  } finally {
    await pool.end()
  }
}

main().catch((err) => {
  console.error('移行中にエラーが発生しました:', err)
  process.exit(1)
})
