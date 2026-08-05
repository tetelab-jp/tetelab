// ============================================
// cron-trigger-worker
// Cloudflare Pagesはネイティブの Cron Trigger (scheduled()) を
// サポートしないため、この単独の軽量Workerが定期的に
// 本体アプリの /api/cron/run-style-posts を叩く役割を担う。
// HANDOFF.md 6-3 / src/routes/automation.ts 参照。
// ============================================

export type Env = {
  TARGET_URL: string // 例: https://xxx.pages.dev/api/cron/run-style-posts
  CRON_SECRET: string
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runStylePostsCron(env))
  },

  // wrangler dev での動作確認用に手動実行もできるようにしておく
  async fetch(_request: Request, env: Env): Promise<Response> {
    const result = await runStylePostsCron(env)
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

async function runStylePostsCron(env: Env): Promise<{ ok: boolean; status: number; body: string }> {
  if (!env.TARGET_URL || !env.CRON_SECRET) {
    console.error('TARGET_URL または CRON_SECRET が未設定です')
    return { ok: false, status: 0, body: 'missing TARGET_URL/CRON_SECRET' }
  }

  const res = await fetch(env.TARGET_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CRON_SECRET}` }
  })
  const body = await res.text()

  if (!res.ok) {
    console.error(`cron呼び出し失敗: ${res.status} ${body.slice(0, 500)}`)
  } else {
    console.log(`cron呼び出し成功: ${body.slice(0, 500)}`)
  }

  return { ok: res.ok, status: res.status, body }
}
