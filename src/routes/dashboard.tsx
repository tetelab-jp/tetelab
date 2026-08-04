import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import type { Bindings, AppUser } from '../types'

const dashboard = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

dashboard.use('*', requireAuth)

function Sidebar({ active, salonName }: { active: string; salonName: string | null }) {
  const items = [
    { key: 'dashboard', href: '/dashboard', icon: 'fa-gauge-high', label: 'ダッシュボード' },
    { key: 'settings', href: '/settings/salonboard', icon: 'fa-key', label: 'サロンボード連携設定' },
    { key: 'posts', href: '#', icon: 'fa-pen-to-square', label: 'ブログ・スタイル投稿', disabled: true }
  ]
  return (
    <aside class="w-64 bg-white border-r border-gray-100 min-h-screen p-5 hidden md:block">
      <div class="flex items-center gap-2 mb-8 px-1">
        <div class="w-9 h-9 rounded-xl bg-pink-500 text-white flex items-center justify-center">
          <i class="fas fa-scissors"></i>
        </div>
        <div>
          <p class="font-bold text-sm leading-tight">サロン自動投稿</p>
          <p class="text-xs text-gray-400 leading-tight">{salonName || 'マイページ'}</p>
        </div>
      </div>
      <nav class="space-y-1">
        {items.map((item) => (
          <a
            href={item.href}
            class={
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ' +
              (item.key === active
                ? 'bg-pink-50 text-pink-600'
                : item.disabled
                  ? 'text-gray-300 cursor-not-allowed'
                  : 'text-gray-600 hover:bg-gray-50')
            }
          >
            <i class={`fas ${item.icon} w-4`}></i>
            <span>{item.label}</span>
            {item.disabled && <span class="ml-auto text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded">Phase2</span>}
          </a>
        ))}
      </nav>
      <form method="post" action="/logout" class="mt-8 px-1">
        <button type="submit" class="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-2">
          <i class="fas fa-arrow-right-from-bracket"></i> ログアウト
        </button>
      </form>
    </aside>
  )
}

function TopBar({ title }: { title: string }) {
  return (
    <header class="border-b border-gray-100 bg-white px-6 py-4 flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-900">{title}</h1>
    </header>
  )
}

// ---------- Dashboard ----------

dashboard.get('/dashboard', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare('SELECT id, consent_given, updated_at FROM salon_credentials WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number; consent_given: number; updated_at: string }>()

  const postsCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM posts WHERE user_id = ?')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.render(
    <div class="flex">
      <Sidebar active="dashboard" salonName={user.salon_name} />
      <div class="flex-1">
        <TopBar title="ダッシュボード" />
        <main class="p-6 space-y-6">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="bg-white rounded-xl border border-gray-100 p-5">
              <p class="text-xs text-gray-400 mb-1">サロンボード連携</p>
              <p class={'text-lg font-bold ' + (cred ? 'text-green-600' : 'text-gray-400')}>
                {cred ? <><i class="fas fa-circle-check mr-1"></i>連携済み</> : <><i class="fas fa-circle-xmark mr-1"></i>未設定</>}
              </p>
            </div>
            <div class="bg-white rounded-xl border border-gray-100 p-5">
              <p class="text-xs text-gray-400 mb-1">投稿予約数</p>
              <p class="text-lg font-bold text-gray-800">{postsCountRow?.cnt ?? 0} 件</p>
            </div>
            <div class="bg-white rounded-xl border border-gray-100 p-5">
              <p class="text-xs text-gray-400 mb-1">自動投稿方式</p>
              <p class="text-lg font-bold text-gray-800">Cloudflare Browser Rendering</p>
            </div>
          </div>

          {!cred && (
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 flex items-start gap-3">
              <i class="fas fa-triangle-exclamation text-amber-500 mt-0.5"></i>
              <div>
                <p class="font-semibold text-amber-800">サロンボードとの連携が未設定です</p>
                <p class="text-sm text-amber-700 mt-1">
                  自動投稿を行うには、まずサロンボードのログインID/パスワードを登録してください。
                </p>
                <a
                  href="/settings/salonboard"
                  class="inline-block mt-3 text-sm font-semibold bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg"
                >
                  連携設定へ進む
                </a>
              </div>
            </div>
          )}

          <div class="bg-white rounded-xl border border-gray-100 p-5">
            <p class="font-semibold mb-2">
              <i class="fas fa-road mr-2 text-pink-500"></i>開発ロードマップ
            </p>
            <ul class="text-sm text-gray-600 space-y-1 list-disc list-inside">
              <li>✅ Phase 1: ログイン・サロンボードID/Pass登録（今回実装分）</li>
              <li>⏳ Phase 2: ブログ・スタイル投稿の入力＆AI生成フォーム</li>
              <li>⏳ Phase 3: Cloudflare Browser Renderingによる自動投稿の実行</li>
            </ul>
          </div>
        </main>
      </div>
    </div>,
    { title: 'ダッシュボード' }
  )
})

// ---------- Salonboard credentials settings ----------

dashboard.get('/settings/salonboard', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const error = c.req.query('error')

  const cred = await c.env.DB.prepare(
    'SELECT salonboard_login_id_enc, consent_given, updated_at FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ salonboard_login_id_enc: string; consent_given: number; updated_at: string }>()

  let maskedLoginId = ''
  if (cred) {
    const encKey = c.env.ENCRYPTION_KEY
    if (encKey) {
      try {
        const loginId = await decryptSecret(cred.salonboard_login_id_enc, encKey)
        maskedLoginId = maskLoginId(loginId)
      } catch {
        maskedLoginId = '(復号エラー: ENCRYPTION_KEYが変更された可能性があります)'
      }
    }
  }

  return c.render(
    <div class="flex">
      <Sidebar active="settings" salonName={user.salon_name} />
      <div class="flex-1">
        <TopBar title="サロンボード連携設定" />
        <main class="p-6 max-w-2xl space-y-6">
          {saved && (
            <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
              <i class="fas fa-circle-check mr-2"></i>保存しました
            </div>
          )}
          {error && (
            <div class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              <i class="fas fa-circle-exclamation mr-2"></i>{error}
            </div>
          )}

          <div class="bg-white rounded-xl border border-gray-100 p-6">
            <p class="font-semibold mb-1">
              <i class="fas fa-shield-halved mr-2 text-pink-500"></i>セキュリティについて
            </p>
            <p class="text-sm text-gray-500 leading-relaxed">
              入力されたログインID・パスワードはAES-GCM方式で暗号化してデータベースに保存されます。
              自動投稿ロボがサロンボードにログインする際のみ、サーバー内で一時的に復号して使用します。
              第三者への提供・目的外利用は行いません。
            </p>
          </div>

          {cred && (
            <div class="bg-white rounded-xl border border-gray-100 p-6">
              <p class="text-xs text-gray-400 mb-1">現在登録されているログインID</p>
              <p class="font-mono text-sm text-gray-700">{maskedLoginId || '（未設定）'}</p>
              <p class="text-xs text-gray-400 mt-2">最終更新: {cred.updated_at}</p>
            </div>
          )}

          <form method="post" action="/settings/salonboard" class="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">サロンボード ログインID</label>
              <input
                required
                type="text"
                name="salonboard_login_id"
                placeholder="サロンボードのログインIDを入力"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
              />
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">サロンボード パスワード</label>
              <input
                required
                type="password"
                name="salonboard_password"
                placeholder="サロンボードのパスワードを入力"
                class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
              />
            </div>
            <label class="flex items-start gap-2 text-sm text-gray-600">
              <input required type="checkbox" name="consent" class="mt-1" />
              <span>
                本サービスがサロンボードへの自動ログイン・自動投稿のためにID/パスワードを保存・利用することに同意します。
              </span>
            </label>
            <button
              type="submit"
              class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
            >
              {cred ? '更新する' : '登録する'}
            </button>
          </form>
        </main>
      </div>
    </div>,
    { title: 'サロンボード連携設定' }
  )
})

dashboard.post('/settings/salonboard', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const loginId = String(body.salonboard_login_id || '').trim()
  const password = String(body.salonboard_password || '')
  const consent = body.consent === 'on' || body.consent === 'true'

  const encKey = c.env.ENCRYPTION_KEY
  if (!encKey) {
    return c.redirect(
      '/settings/salonboard?error=' +
        encodeURIComponent('サーバー設定エラー: ENCRYPTION_KEYが未設定です。管理者に連絡してください。')
    )
  }

  if (!loginId || !password || !consent) {
    return c.redirect(
      '/settings/salonboard?error=' + encodeURIComponent('ログインID・パスワード・同意チェックはすべて必須です')
    )
  }

  const loginIdEnc = await encryptSecret(loginId, encKey)
  const passwordEnc = await encryptSecret(password, encKey)

  const existing = await c.env.DB.prepare('SELECT id FROM salon_credentials WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE salon_credentials
       SET salonboard_login_id_enc = ?, salonboard_password_enc = ?, consent_given = 1, consent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    )
      .bind(loginIdEnc, passwordEnc, user.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO salon_credentials (user_id, salonboard_login_id_enc, salonboard_password_enc, consent_given, consent_at)
       VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
    )
      .bind(user.id, loginIdEnc, passwordEnc)
      .run()
  }

  return c.redirect('/settings/salonboard?saved=1')
})

function maskLoginId(loginId: string): string {
  if (loginId.length <= 2) return '*'.repeat(loginId.length)
  const visible = loginId.slice(0, 2)
  return visible + '*'.repeat(Math.max(loginId.length - 2, 3))
}

export default dashboard
