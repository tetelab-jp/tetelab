import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { encryptSecret, decryptSecret } from '../lib/crypto'
import { PageLayout } from '../components/layout'
import { launchBrowser, newAutomationPage, loginToSalonBoard } from '../lib/salonboard-automation'
import { syncStylists, syncCoupons } from '../lib/salonboard-sync'
import { formatJstDateTime } from '../lib/date-format'
import type { Bindings, AppUser } from '../types'

const dashboard = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

dashboard.use('*', requireAuth)

// ---------- Dashboard ----------

dashboard.get('/dashboard', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare(
    'SELECT id, consent_given, updated_at, connection_status FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ id: number; consent_given: number; updated_at: string; connection_status: string }>()
  const isConnected = cred?.connection_status === 'success'

  const postsCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM posts WHERE user_id = ?')
    .bind(user.id)
    .first<{ cnt: number }>()

  const styleTotalRow = await c.env.DB.prepare('SELECT COUNT(*) as total FROM styles WHERE user_id = ?')
    .bind(user.id)
    .first<{ total: number }>()

  const styleSelectedRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as selected FROM styles WHERE user_id = ? AND auto_post_enabled_flag = 1'
  )
    .bind(user.id)
    .first<{ selected: number }>()

  return c.render(
    <PageLayout active="dashboard" salonName={user.salon_name} title="ダッシュボード">
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="text-xs text-gray-400 mb-1">サロンボード連携</p>
          <p class={'text-lg font-bold ' + (isConnected ? 'text-green-600' : cred ? 'text-amber-500' : 'text-gray-400')}>
            {isConnected ? (
              <><i class="fas fa-circle-check mr-1"></i>連携済み</>
            ) : cred ? (
              <><i class="fas fa-triangle-exclamation mr-1"></i>未確認/失敗</>
            ) : (
              <><i class="fas fa-circle-xmark mr-1"></i>未設定</>
            )}
          </p>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="text-xs text-gray-400 mb-1">スタイル画像（選択中/総数）</p>
          <p class="text-lg font-bold text-gray-800">
            {styleSelectedRow?.selected ?? 0} / {styleTotalRow?.total ?? 0} 枚
          </p>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="text-xs text-gray-400 mb-1">ブログ投稿予約数</p>
          <p class="text-lg font-bold text-gray-800">{postsCountRow?.cnt ?? 0} 件</p>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="text-xs text-gray-400 mb-1">自動投稿方式</p>
          <p class="text-base font-bold text-gray-800">Browser Rendering</p>
        </div>
      </div>

      {!isConnected && (
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 flex items-start gap-3">
          <i class="fas fa-triangle-exclamation text-amber-500 mt-0.5"></i>
          <div>
            <p class="font-semibold text-amber-800">
              {cred ? 'サロンボードとの連携がまだ確認できていません' : 'サロンボードとの連携が未設定です'}
            </p>
            <p class="text-sm text-amber-700 mt-1">
              {cred
                ? 'ログインID/パスワードは登録済みですが、実際にサロンボードへログインできたことがまだ確認されていません。連携設定ページで「サロンボードと同期する」を実行して確認してください。'
                : '自動投稿を行うには、まずサロンボードのログインID/パスワードを登録してください。'}
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

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="font-semibold mb-2">
            <i class="fas fa-images mr-2 text-pink-500"></i>スタイル投稿
          </p>
          <p class="text-sm text-gray-600 mb-3">
            画像ライブラリに事前登録し、チェックした画像のみ自動投稿されます。
          </p>
          <a href="/style/library" class="text-sm font-semibold text-pink-600 hover:underline">
            画像ライブラリを開く <i class="fas fa-arrow-right ml-1"></i>
          </a>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="font-semibold mb-2">
            <i class="fas fa-pen-to-square mr-2 text-pink-500"></i>ブログ投稿
          </p>
          <p class="text-sm text-gray-600 mb-3">
            投稿者・カテゴリ・クーポンを事前登録し、AIで本文を生成して投稿予約できます。
          </p>
          <a href="/blog/posts" class="text-sm font-semibold text-pink-600 hover:underline">
            ブログ投稿を作成する <i class="fas fa-arrow-right ml-1"></i>
          </a>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-5">
        <p class="font-semibold mb-2">
          <i class="fas fa-road mr-2 text-pink-500"></i>開発ロードマップ
        </p>
        <ul class="text-sm text-gray-600 space-y-1 list-disc list-inside">
          <li>✅ Phase 1: ログイン・サロンボードID/Pass登録</li>
          <li>✅ Phase 2: スタイル画像ライブラリ・自動投稿スケジュール、ブログ基本設定・AI生成</li>
          <li>⏳ Phase 3: Cloudflare Browser Renderingによる自動投稿の実行</li>
        </ul>
      </div>
    </PageLayout>,
    { title: 'ダッシュボード' }
  )
})

// ---------- Salonboard credentials settings ----------

dashboard.get('/settings/salonboard', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const error = c.req.query('error')

  const cred = await c.env.DB.prepare(
    'SELECT salonboard_login_id_enc, consent_given, updated_at, last_stylist_synced_at, last_coupon_synced_at, connection_status, last_error FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{
      salonboard_login_id_enc: string
      consent_given: number
      updated_at: string
      last_stylist_synced_at: string | null
      last_coupon_synced_at: string | null
      connection_status: string
      last_error: string | null
    }>()

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

  const stylistCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM stylists WHERE user_id = ?')
    .bind(user.id)
    .first<{ cnt: number }>()
  const couponCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM coupons WHERE user_id = ?')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.render(
    <PageLayout active="settings" salonName={user.salon_name} title="サロンボード連携設定">
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

      <div class="max-w-2xl space-y-6">
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
            <p class="text-xs text-gray-400 mt-2">最終更新: {formatJstDateTime(cred.updated_at)}</p>
            <div class="mt-3 pt-3 border-t border-gray-100">
              <p class="text-xs text-gray-400 mb-1">連携ステータス（実際にログインできたかの確認結果）</p>
              {cred.connection_status === 'success' ? (
                <p class="text-sm font-semibold text-green-600">
                  <i class="fas fa-circle-check mr-1"></i>連携確認済み（サロンボードへのログインに成功しています）
                </p>
              ) : cred.connection_status === 'failed' ? (
                <div>
                  <p class="text-sm font-semibold text-red-600">
                    <i class="fas fa-circle-exclamation mr-1"></i>連携失敗（サロンボードへのログインに失敗しています）
                  </p>
                  {cred.last_error && <p class="text-xs text-red-500 mt-1 break-all">{cred.last_error}</p>}
                </div>
              ) : (
                <p class="text-sm font-semibold text-gray-500">
                  <i class="fas fa-circle-question mr-1"></i>未確認（まだログインを試したことがありません）
                </p>
              )}
              <p class="text-xs text-gray-400 mt-1">
                下の「サロンボードと同期する」ボタンを押すと、実際にログインを試して最新の状態に更新します。
              </p>
            </div>
          </div>
        )}

        {cred && (
          <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
            <p class="font-semibold">
              <i class="fas fa-rotate mr-2 text-pink-500"></i>スタイリスト・クーポンの同期
            </p>
            <p class="text-sm text-gray-500 leading-relaxed">
              サロンボードに登録されているスタイリスト・クーポンの一覧を取得し、このアプリのスタイル投稿フォームで選べるようにします。
              スタイリストやクーポンを追加・変更した場合は再度同期してください。
            </p>
            <div class="grid grid-cols-2 gap-3 text-sm">
              <div class="bg-gray-50 rounded-lg p-3">
                <p class="text-xs text-gray-400">スタイリスト</p>
                <p class="font-bold text-gray-800">{stylistCountRow?.cnt ?? 0} 件</p>
                <p class="text-xs text-gray-400 mt-1">最終同期: {cred.last_stylist_synced_at ? formatJstDateTime(cred.last_stylist_synced_at) : '未実施'}</p>
              </div>
              <div class="bg-gray-50 rounded-lg p-3">
                <p class="text-xs text-gray-400">クーポン</p>
                <p class="font-bold text-gray-800">{couponCountRow?.cnt ?? 0} 件</p>
                <p class="text-xs text-gray-400 mt-1">最終同期: {cred.last_coupon_synced_at ? formatJstDateTime(cred.last_coupon_synced_at) : '未実施'}</p>
              </div>
            </div>
            <button
              id="sync-stylists-coupons-btn"
              type="button"
              class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <i class="fas fa-rotate mr-1"></i>サロンボードと同期する
            </button>
            <p id="sync-stylists-coupons-status" class="text-sm"></p>
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
      </div>

      {cred && <script src="/static/salonboard-sync.js"></script>}
    </PageLayout>,
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

// ---------- スタイリスト・クーポン同期 ----------

dashboard.post('/api/settings/sync-stylists-coupons', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare(
    'SELECT salonboard_login_id_enc, salonboard_password_enc FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string }>()

  if (!cred) return c.json({ success: false, error: 'サロンボードのログイン情報が未登録です' }, 400)
  if (!c.env.ENCRYPTION_KEY) return c.json({ success: false, error: 'ENCRYPTION_KEYが未設定です' }, 500)

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
    const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

    browser = await launchBrowser(c.env)
    const page = await newAutomationPage(browser)
    await loginToSalonBoard(page, loginId, password, () => {}, c.env, user.id)

    const stylistCount = await syncStylists(page, c.env, user.id, () => {})
    const couponCount = await syncCoupons(page, c.env, user.id, () => {})

    return c.json({ success: true, stylistCount, couponCount })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

function maskLoginId(loginId: string): string {
  if (loginId.length <= 2) return '*'.repeat(loginId.length)
  const visible = loginId.slice(0, 2)
  return visible + '*'.repeat(Math.max(loginId.length - 2, 3))
}

export default dashboard
