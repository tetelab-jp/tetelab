import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { encryptSecret, decryptSecret, hashPassword, verifyPasswordConstantTime } from '../lib/crypto'
import { PageLayout } from '../components/layout'
import {
  launchBrowser,
  newAutomationPage,
  loginToSalonBoard,
  handleGroupTopIfPresent,
  listGroupTopSalons,
  type SalonListEntry
} from '../lib/salonboard-automation'
import { syncStylists, syncCoupons, syncSalonInfo, syncSalonArea, upsertSalonInfo } from '../lib/salonboard-sync'
import { formatJstDateTime, formatJstDate } from '../lib/date-format'
import type { Bindings, AppUser } from '../types'

const dashboard = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

// 2026-08-12追記(重大バグ修正): '*'で登録すると、index.tsxで全サブアプリが
// 同じベースパス('/')にapp.route()マウントされている都合上、このサブアプリに
// 存在しないパス(例: /admin/*)に対してもこのミドルウェアが先に反応し、
// 未ログイン/契約OFF等の理由でリダイレクトを返してしまい、後続でマウントされる
// 他のサブアプリ(admin等)へのリクエストを乗っ取ってしまう(実機で確認済みの
// 不具合)。自分が実際に持つルートのパスパターンだけを明示することで防ぐ。
dashboard.use('/dashboard', requireAuth)
dashboard.use('/settings/*', requireAuth)
dashboard.use('/api/settings/*', requireAuth)

// ---------- Dashboard ----------

dashboard.get('/dashboard', async (c) => {
  const user = c.get('user')
  const blockedError = c.req.query('error')
  const cred = await c.env.DB.prepare(
    'SELECT id, consent_given, updated_at, connection_status, last_stylist_synced_at, last_coupon_synced_at, last_error FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{
      id: number
      consent_given: number
      updated_at: string
      connection_status: string
      last_stylist_synced_at: string | null
      last_coupon_synced_at: string | null
      last_error: string | null
    }>()
  const isConnected = cred?.connection_status === 'success'

  const blogArticlesRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'approved') as approved FROM blog_articles WHERE user_id = ? AND salon_id = ?"
  )
    .bind(user.id, user.active_salon_id)
    .first<{ total: number; approved: number }>()

  const styleTotalRow = await c.env.DB.prepare('SELECT COUNT(*) as total FROM styles WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ total: number }>()

  const styleSelectedRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as selected FROM styles WHERE user_id = ? AND salon_id = ? AND auto_post_enabled_flag = 1'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ selected: number }>()

  const stylistCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM stylists WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()
  const couponCountRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM coupons WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()

  // 複数サロンワークスペース対応: 契約枠に余裕があれば「追加サロンを利用する」
  // 導線を表示する(単一サロンのままの大多数のアカウントには表示されない)。
  const activeSalonCountRow = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM salonboard_salons WHERE user_id = ? AND is_active_workspace = 1'
  )
    .bind(user.id)
    .first<{ cnt: number }>()
  const activeSalonCount = activeSalonCountRow?.cnt ?? 0
  const canAddSalon = cred ? user.salon_slot_limit > activeSalonCount : false

  // ダッシュボード最上部に表示する、HPB(サロンボード)連携で取得した実際の
  // サロン名(users.salon_nameは氏名を保持しているため使わない)。
  const activeSalonInfo = user.active_salon_id
    ? await c.env.DB.prepare('SELECT salon_name FROM salonboard_salons WHERE id = ?')
        .bind(user.active_salon_id)
        .first<{ salon_name: string | null }>()
    : null

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      active="dashboard"
      salonName={user.salon_name}
      title="ダッシュボード"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
      {activeSalonInfo?.salon_name && (
        <div class="flex items-center gap-2 min-w-0">
          <i class="fas fa-shop text-pink-500 text-sm md:text-lg flex-shrink-0"></i>
          <h2 class="text-base md:text-2xl font-bold text-gray-900 truncate">{activeSalonInfo.salon_name}</h2>
        </div>
      )}
      {blockedError && (
        <div class="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-exclamation mr-2"></i>
          {blockedError}
        </div>
      )}
      {cred && (
        <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
          <p class="font-semibold"><i class="fas fa-rotate mr-2 text-pink-500"></i>サロンボードと同期する</p>
          <p class="text-sm text-gray-500 leading-relaxed">
            作業開始の前に必ずこちらから同期をしてください。
            <br />
            登録されているスタイリスト・クーポンの一覧を取得し、スタイル投稿フォームで選べるようにします。
            <br />
            ※サロンボードのスタイリストやクーポンを追加・変更した場合は再度同期してください。
          </p>
          <button
            id="sync-stylists-coupons-btn"
            type="button"
            class="w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            サロンボードと同期する
          </button>
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-400">スタイリスト</p>
              <p class="font-bold text-gray-800">{stylistCountRow?.cnt ?? 0} 件</p>
              <p class="text-xs text-gray-400 mt-1 flex flex-col md:flex-row md:gap-1">
                <span>最終同期:</span>
                <span class="whitespace-nowrap">{cred.last_stylist_synced_at ? formatJstDate(cred.last_stylist_synced_at) : '未実施'}</span>
              </p>
            </div>
            <div class="bg-gray-50 rounded-lg p-3">
              <p class="text-xs text-gray-400">クーポン</p>
              <p class="font-bold text-gray-800">{couponCountRow?.cnt ?? 0} 件</p>
              <p class="text-xs text-gray-400 mt-1 flex flex-col md:flex-row md:gap-1">
                <span>最終同期:</span>
                <span class="whitespace-nowrap">{cred.last_coupon_synced_at ? formatJstDate(cred.last_coupon_synced_at) : '未実施'}</span>
              </p>
            </div>
          </div>
          <p id="sync-stylists-coupons-status" class="text-sm"></p>
          <div id="salon-select-area"></div>
        </div>
      )}

      {canAddSalon && (
        <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
          <p class="font-semibold"><i class="fas fa-store mr-2 text-pink-500"></i>追加サロンを利用する</p>
          <p class="text-sm text-gray-500 leading-relaxed">
            現在{activeSalonCount}/{user.salon_slot_limit}サロンをご利用中です。同じサロンボードログインに紐づく
            他のサロンを追加で利用できます。
          </p>
          <button
            id="fetch-available-salons-btn"
            type="button"
            class="w-full md:w-auto bg-white border border-pink-400 text-pink-600 hover:bg-pink-50 font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            追加サロンを選択する
          </button>
          <p id="fetch-available-salons-status" class="text-sm"></p>
          <div id="additional-salon-area"></div>
        </div>
      )}

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
            登録スタイルに事前登録し、チェックした画像のみ自動投稿されます。
          </p>
          <a href="/style/library" class="text-sm font-semibold text-pink-600 hover:underline">
            登録スタイルを開く <i class="fas fa-arrow-right ml-1"></i>
          </a>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="font-semibold mb-2">
            <i class="fas fa-pen-to-square mr-2 text-pink-500"></i>ブログ投稿
          </p>
          <p class="text-sm text-gray-600 mb-3">
            カテゴリ別テンプレートで画像から記事をAI生成し、承認した記事を投稿できます。
          </p>
          <a href="/blog/articles" class="text-sm font-semibold text-pink-600 hover:underline">
            投稿記事一覧を開く <i class="fas fa-arrow-right ml-1"></i>
          </a>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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
          <p class="text-xs text-gray-400 mb-1">ブログ記事（承認済み/総数）</p>
          <p class="text-lg font-bold text-gray-800">
            {blogArticlesRow?.approved ?? 0} / {blogArticlesRow?.total ?? 0} 件
          </p>
        </div>
      </div>

      {cred && (
        <div class="max-w-2xl">
          <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-2">
            <p class="font-semibold"><i class="fas fa-key mr-2 text-pink-500"></i>サロンボード連携設定</p>
            <p class="text-xs text-gray-400">
              サロンID・ログインID・パスワードの確認/更新は
              <a href="/settings/salonboard" class="text-pink-600 font-medium hover:underline">連携設定ページ</a>
              から行えます。
            </p>
          </div>
        </div>
      )}

      {cred && <script src="/static/salonboard-sync.js"></script>}
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
    'SELECT salonboard_login_id_enc, consent_given, updated_at, connection_status, last_error FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{
      salonboard_login_id_enc: string
      consent_given: number
      updated_at: string
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

  // 複数サロン対応: 「サロンID」はサロンボードのID/パスワードだけでなく重要な
  // 識別情報になるため表示する(現在アクティブなワークスペースの物理サロンID)。
  let activeSalonKey: string | null = null
  if (cred && user.active_salon_id) {
    const activeSalon = await c.env.DB.prepare('SELECT salon_key FROM salonboard_salons WHERE id = ?')
      .bind(user.active_salon_id)
      .first<{ salon_key: string | null }>()
    activeSalonKey = activeSalon?.salon_key ?? null
  }

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      active="settings"
      salonName={user.salon_name}
      title="サロンボード連携設定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
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

        {cred ? (
          <>
            <div class="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
              <div>
                <p class="text-xs text-gray-400 mb-1">サロンID</p>
                <p class="font-mono text-sm text-gray-700">{activeSalonKey || '（未確定）'}</p>
              </div>
              <div class="pt-3 border-t border-gray-100">
                <p class="text-xs text-gray-400 mb-1">サロンボード ログインID</p>
                <p class="font-mono text-sm text-gray-700">{maskedLoginId || '（未設定）'}</p>
                <p class="text-xs text-gray-400 mt-2">最終更新: {formatJstDateTime(cred.updated_at)}</p>
              </div>
              <div class="pt-3 border-t border-gray-100">
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
                  <a href="/dashboard" class="text-pink-600 hover:underline">ダッシュボード</a>の「サロンボードと同期する」ボタンを押すと、実際にログインを試して最新の状態に更新します。
                </p>
              </div>
            </div>

            <form method="post" action="/settings/salonboard" autocomplete="off" class="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
              <p class="text-xs text-gray-500 leading-relaxed">
                サロンID・ログインIDはサロンボード連携時に確定した固定情報のため変更できません。
                サロンボード側でパスワードを変更した場合は、こちらで最新のパスワードに更新してください。
              </p>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-1">サロンボード パスワード</label>
                <input
                  required
                  type="password"
                  name="salonboard_password"
                  autocomplete="new-password"
                  placeholder="新しいパスワードを入力"
                  class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
                />
              </div>
              <button
                type="submit"
                class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
              >
                パスワードを更新する
              </button>
            </form>
          </>
        ) : (
          <form
            method="post"
            action="/settings/salonboard"
            autocomplete="off"
            class="bg-white rounded-xl border border-gray-100 p-6 space-y-4"
          >
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">サロンボード ログインID</label>
              <input
                required
                type="text"
                name="salonboard_login_id"
                autocomplete="off"
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
                autocomplete="new-password"
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
              登録する
            </button>
          </form>
        )}

        {cred && (
          <div
            id="salonboard-onboarding-area"
            // 重大バグ修正: 以前はsalon_key(サロンID)の有無だけで判定していたが、
            // upsertSalonInfoの不具合(修正済み)によりsalon_keyがいつまでも
            // 確定しないケースがあった。connection_status(ログイン試行そのものの
            // 成否)も合わせて見ることで、(a)ログインがまだ成功していない、
            // (b)ログインには成功したがウィザード途中(契約店舗数/サロン選択が
            // 未完了)で離脱した、のどちらの場合も再開できるようにする。
            // 両方が揃って初めて「連携完了」とみなし自動実行しない。
            data-autorun={cred.connection_status !== 'success' || !activeSalonKey ? '1' : ''}
            class="space-y-3"
          ></div>
        )}
      </div>

      <script src="/static/salonboard-sync.js"></script>
    </PageLayout>,
    { title: 'サロンボード連携設定' }
  )
})

dashboard.post('/settings/salonboard', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const password = String(body.salonboard_password || '')

  const encKey = c.env.ENCRYPTION_KEY
  if (!encKey) {
    return c.redirect(
      '/settings/salonboard?error=' +
        encodeURIComponent('サーバー設定エラー: ENCRYPTION_KEYが未設定です。管理者に連絡してください。')
    )
  }

  const existing = await c.env.DB.prepare('SELECT id FROM salon_credentials WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  if (existing) {
    // 連携済みアカウントの更新: パスワードのみ受け付ける(サロンID・ログインIDは
    // 連携時に確定済みの固定情報のため、この画面からは変更できない)。
    if (!password) {
      return c.redirect('/settings/salonboard?error=' + encodeURIComponent('新しいパスワードを入力してください'))
    }
    const passwordEnc = await encryptSecret(password, encKey)
    await c.env.DB.prepare(
      `UPDATE salon_credentials SET salonboard_password_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(passwordEnc, user.id)
      .run()
    return c.redirect('/settings/salonboard?saved=1')
  }

  // 初回連携: ログインID・パスワード・同意チェックが必須。
  const loginId = String(body.salonboard_login_id || '').trim()
  const consent = body.consent === 'on' || body.consent === 'true'
  if (!loginId || !password || !consent) {
    return c.redirect(
      '/settings/salonboard?error=' + encodeURIComponent('ログインID・パスワード・同意チェックはすべて必須です')
    )
  }

  const loginIdEnc = await encryptSecret(loginId, encKey)
  const passwordEnc = await encryptSecret(password, encKey)
  await c.env.DB.prepare(
    `INSERT INTO salon_credentials (user_id, salonboard_login_id_enc, salonboard_password_enc, consent_given, consent_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)`
  )
    .bind(user.id, loginIdEnc, passwordEnc)
    .run()

  return c.redirect('/settings/salonboard?saved=1')
})

// ---------- アカウント設定(メールアドレス・パスワード変更) ----------

dashboard.get('/settings/account', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const error = c.req.query('error')

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}
      active="settings-account"
      salonName={user.salon_name}
      title="アカウント設定"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
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

      <div class="max-w-2xl">
        <form
          method="post"
          action="/settings/account"
          autocomplete="off"
          class="bg-white rounded-xl border border-gray-100 p-6 space-y-4"
        >
          <p class="font-semibold">
            <i class="fas fa-user-gear mr-2 text-pink-500"></i>メールアドレス・パスワードの変更
          </p>
          <p class="text-xs text-gray-500 leading-relaxed">
            変更を保存するには、確認のため現在のパスワードの入力が必要です。
            メールアドレス・新しいパスワードは、変更したい項目だけ入力してください。
          </p>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">メールアドレス（現在: {user.email}）</label>
            <input
              type="email"
              name="new_email"
              placeholder="変更する場合のみ入力"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
            <input
              type="password"
              name="new_password"
              autocomplete="new-password"
              placeholder="変更する場合のみ入力（8文字以上）"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
          </div>
          <div class="pt-3 border-t border-gray-100">
            <label class="block text-sm font-medium text-gray-700 mb-1">現在のパスワード（確認のため必須）</label>
            <input
              required
              type="password"
              name="current_password"
              autocomplete="current-password"
              placeholder="現在お使いのパスワードを入力"
              class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-400"
            />
          </div>
          <button
            type="submit"
            class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
          >
            保存する
          </button>
        </form>
      </div>
    </PageLayout>,
    { title: 'アカウント設定' }
  )
})

dashboard.post('/settings/account', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const newEmail = String(body.new_email || '').trim().toLowerCase()
  const newPassword = String(body.new_password || '')
  const currentPassword = String(body.current_password || '')

  const redirectError = (message: string) => c.redirect('/settings/account?error=' + encodeURIComponent(message))

  if (!newEmail && !newPassword) {
    return redirectError('メールアドレスまたはパスワードのどちらか一方は入力してください')
  }
  if (newPassword && newPassword.length < 8) {
    return redirectError('新しいパスワードは8文字以上で入力してください')
  }

  const current = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>()
  const passwordOk = await verifyPasswordConstantTime(currentPassword, current?.password_hash ?? null)
  if (!passwordOk) {
    return redirectError('現在のパスワードが正しくありません')
  }

  if (newEmail && newEmail !== user.email) {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?')
      .bind(newEmail, user.id)
      .first<{ id: number }>()
    if (existing) {
      return redirectError('このメールアドレスは既に使用されています')
    }
    await c.env.DB.prepare('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(newEmail, user.id)
      .run()
  }

  if (newPassword) {
    const passwordHash = await hashPassword(newPassword)
    await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(passwordHash, user.id)
      .run()
  }

  return c.redirect('/settings/account?saved=1')
})

// ---------- スタイリスト・クーポン同期 ----------

dashboard.post('/api/settings/sync-stylists-coupons', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare(
    'SELECT salonboard_login_id_enc, salonboard_password_enc, target_store_id FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string; target_store_id: string | null }>()

  if (!cred) return c.json({ success: false, error: 'サロンボードのログイン情報が未登録です' }, 400)
  if (!c.env.ENCRYPTION_KEY) return c.json({ success: false, error: 'ENCRYPTION_KEYが未設定です' }, 500)

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  // 2026-08-10追記: loginToSalonBoard()に空関数のloggerを渡していたため、
  // 診断用ログ(diagnoseOutboundConnectivity()の疎通確認結果等)が
  // CloudWatch Logsにしか出ず、画面上のエラーメッセージからは見えなかった。
  // 収集してエラー時のレスポンスに含める。
  const logLines: string[] = []
  const collectLog = (msg: string) => logLines.push(msg)
  try {
    const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
    const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

    console.log(`[sync-stylists-coupons] user=${user.id} ブラウザ起動開始`)
    browser = await launchBrowser()
    const page = await newAutomationPage(browser)
    console.log(`[sync-stylists-coupons] user=${user.id} ログイン開始`)
    await loginToSalonBoard(page, loginId, password, collectLog, c.env, user.id)
    console.log(`[sync-stylists-coupons] user=${user.id} ログイン成功、同期開始`)

    // 複数サロンアカウント対応: ログイン直後に「サロン一覧」中間ページが出た場合、
    // 対象サロンを確定させる(未確定かつ2件以上ある場合はユーザーに選択してもらう)
    const groupTopResult = await handleGroupTopIfPresent(page, cred.target_store_id, collectLog)
    if (groupTopResult.status === 'needs_selection' || groupTopResult.status === 'target_not_found') {
      // 2026-08-14追記(ユーザー指定): 複数サロン検出時、以前はここでウィザードが
      // 顧客に店舗選択させ、確定した1件をそのまま新規登録時のプレースホルダー行
      // (salon_key未設定、is_active_workspace=1)に転用していたが、以降は
      // 「どのサロンを有効化するか」を管理者サイト側で運営が決める運用に変更した。
      // upsertSalonListFromGroupTop()をそのまま呼ぶと(placeholder-adoption
      // フォールバックにより)検出順で先頭のサロンが意図せず自動的に有効化
      // されてしまうため、先にプレースホルダー行を削除しておき(users.active_salon_id
      // はON DELETE SET NULLのため自動的にNULLへ戻る)、検出した全サロンを
      // is_active_workspace=0のまま新規登録させる(管理者が/admin/salonsの
      // 「有効化する」から明示的に選ぶまで、どのサロンも有効化されない状態にする)。
      await c.env.DB.prepare(
        `DELETE FROM salonboard_salons WHERE user_id = ? AND salon_key IS NULL AND is_active_workspace = 1`
      )
        .bind(user.id)
        .run()
      await upsertSalonListFromGroupTop(c.env, user.id, groupTopResult.salons)
      return c.json({
        success: false,
        needsSalonSelection: true,
        salons: groupTopResult.salons,
        error:
          groupTopResult.status === 'target_not_found'
            ? '以前選択したサロンが見つかりませんでした。サロンを選び直してください'
            : 'このアカウントには複数のサロンが登録されています。使用するサロンを選択してください'
      })
    }
    if (groupTopResult.status === 'resolved') {
      // 複数サロンワークスペース対応: 新規登録時に作られたプレースホルダー行
      // (salon_key未設定、is_active_workspace=1)がこのユーザーの実質1個目の
      // ワークスペースを表している場合、実際に解決したSTORE_IDへ転用する
      // (新規行を増やさない。src/index.tsxのフェーズ0バックフィルと同じ考え方)。
      await c.env.DB.prepare(
        `UPDATE salonboard_salons SET salon_key = ?
         WHERE user_id = ? AND salon_key IS NULL AND is_active_workspace = 1
           AND NOT EXISTS (SELECT 1 FROM salonboard_salons WHERE user_id = ? AND salon_key = ?)`
      )
        .bind(groupTopResult.storeId, user.id, user.id, groupTopResult.storeId)
        .run()

      await upsertSalonListFromGroupTop(c.env, user.id, groupTopResult.salons)
      if (!cred.target_store_id) {
        await c.env.DB.prepare('UPDATE salon_credentials SET target_store_id = ? WHERE user_id = ?')
          .bind(groupTopResult.storeId, user.id)
          .run()
      }

      // 有効化(is_active_workspace)とactive_salon_idを確定させる。
      // 既に有効化・確定済みの場合は何も変わらない(冪等)。
      await c.env.DB.prepare(
        `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP)
         WHERE user_id = ? AND salon_key = ?`
      )
        .bind(user.id, groupTopResult.storeId)
        .run()
      await c.env.DB.prepare(
        `UPDATE users u SET active_salon_id = s.id
         FROM salonboard_salons s
         WHERE u.id = ? AND s.user_id = ? AND s.salon_key = ? AND u.active_salon_id IS NULL`
      )
        .bind(user.id, user.id, groupTopResult.storeId)
        .run()

      const resolvedSalon = groupTopResult.salons.find((s) => s.storeId === groupTopResult.storeId)
      if (resolvedSalon?.type === 'kirei') {
        // キレイサロン(ネイル/まつげ等)にはスタイル機能が存在しないため無効化する
        await c.env.DB.prepare('UPDATE users SET style_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(user.id)
          .run()
      }
    }

    // 複数サロンワークスペース対応: 上記の解決処理でactive_salon_idが今回
    // 初めて確定した可能性があるため(requireAuthで読み込んだuser.active_salon_id
    // は古い値のまま)、同期先を確定させるために改めて読み直す。
    const freshUser = await c.env.DB.prepare('SELECT active_salon_id FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ active_salon_id: number | null }>()
    const activeSalonId = freshUser?.active_salon_id ?? user.active_salon_id

    // ログイン直後のヘッダーからサロン名/サロンIDを取得して保存(フリーワード対策で利用)。
    // collectLogに渡すことで、取得失敗時の診断情報(URL/タイトル/画面テキスト)が
    // エラーレスポンス・CloudWatch Logsの両方に残るようにする。
    const salonInfo = await syncSalonInfo(page, c.env, user.id, collectLog)
    if (salonInfo?.storeId) {
      // サロンID(STORE_ID)からHPBの公開サロンページを開き、対策エリア(中/小)を自動検出する
      await syncSalonArea(c.env, user.id, `sln${salonInfo.storeId}`, () => {})
    }
    const stylistCount = await syncStylists(page, c.env, user.id, activeSalonId, () => {})
    const couponCount = await syncCoupons(page, c.env, user.id, activeSalonId, () => {})
    console.log(
      `[sync-stylists-coupons] user=${user.id} 完了 salon=${salonInfo?.storeId || '-'} stylists=${stylistCount} coupons=${couponCount}`
    )

    return c.json({ success: true, stylistCount, couponCount, salonName: salonInfo?.salonName || null })
  } catch (err: any) {
    console.error(`[sync-stylists-coupons] user=${user.id} エラー:`, err?.stack || err)
    const diagnostics = logLines.length > 0 ? ` / 診断ログ: ${logLines.join(' | ')}` : ''
    return c.json({ success: false, error: (String(err?.message || err) + diagnostics).slice(0, 2000) }, 400)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

/** 複数サロン一覧(handleGroupTopIfPresentの結果)をsalonboard_salonsへ一括upsertする */
async function upsertSalonListFromGroupTop(env: Bindings, userId: number, salons: SalonListEntry[]): Promise<void> {
  for (const salon of salons) {
    await upsertSalonInfo(env, userId, { storeId: salon.storeId, salonName: salon.name }, salon.type)
  }
}

// 最初の1サロン目を選ぶフロー(複数サロン検出時に必ず1件選ぶ必要がある)。
// 追加サロン(2件目以降)の選択は/api/settings/activate-additional-salonで行う。
dashboard.post('/api/settings/select-salon', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const storeId = String(body.storeId || '').trim()
  if (!storeId) return c.json({ success: false, error: 'storeIdが指定されていません' }, 400)

  const salon = await c.env.DB.prepare(
    'SELECT id, salon_type FROM salonboard_salons WHERE user_id = ? AND salon_key = ?'
  )
    .bind(user.id, storeId)
    .first<{ id: number; salon_type: string | null }>()
  if (!salon) return c.json({ success: false, error: '指定されたサロンが見つかりません' }, 400)

  await c.env.DB.prepare('UPDATE salon_credentials SET target_store_id = ? WHERE user_id = ?')
    .bind(storeId, user.id)
    .run()

  // 新規登録時に作られたプレースホルダー行(salon_key未設定)がこのユーザーの
  // 実質1個目のワークスペースを表している場合、選んだサロンへ転用する
  // (新規行を増やさない)。
  await c.env.DB.prepare(
    `UPDATE salonboard_salons SET salon_key = ?
     WHERE user_id = ? AND salon_key IS NULL AND is_active_workspace = 1
       AND NOT EXISTS (SELECT 1 FROM salonboard_salons WHERE user_id = ? AND salon_key = ?)`
  )
    .bind(storeId, user.id, user.id, storeId)
    .run()

  await c.env.DB.prepare(
    `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP)
     WHERE user_id = ? AND salon_key = ?`
  )
    .bind(user.id, storeId)
    .run()
  await c.env.DB.prepare(
    `UPDATE users u SET active_salon_id = s.id
     FROM salonboard_salons s
     WHERE u.id = ? AND s.user_id = ? AND s.salon_key = ?`
  )
    .bind(user.id, user.id, storeId)
    .run()

  if (salon.salon_type === 'kirei') {
    await c.env.DB.prepare('UPDATE users SET style_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(user.id)
      .run()
  }

  return c.json({ success: true })
})

// 複数サロンワークスペース対応 フェーズ4: 追加サロン選択。
// salon_slot_limitに余裕があるユーザーが、まだ有効化していない物理サロンを
// 一覧取得する。確定クリックは行わない(listGroupTopSalons)。
dashboard.post('/api/settings/fetch-available-salons', async (c) => {
  const user = c.get('user')

  const slotRow = await c.env.DB.prepare(
    `SELECT salon_slot_limit,
       (SELECT COUNT(*) FROM salonboard_salons WHERE user_id = ? AND is_active_workspace = 1) AS active_count
     FROM users WHERE id = ?`
  )
    .bind(user.id, user.id)
    .first<{ salon_slot_limit: number; active_count: number }>()
  if (!slotRow || slotRow.active_count >= slotRow.salon_slot_limit) {
    return c.json({ success: false, error: '追加できるサロンの枠がありません。管理者にお問い合わせください' }, 400)
  }

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

    browser = await launchBrowser()
    const page = await newAutomationPage(browser)
    await loginToSalonBoard(page, loginId, password, () => {}, c.env, user.id)

    const allSalons = await listGroupTopSalons(page, () => {})
    if (!allSalons) {
      return c.json({ success: false, error: 'このアカウントには追加できるサロンがありません' }, 400)
    }

    await upsertSalonListFromGroupTop(c.env, user.id, allSalons)

    const { results: activeRows } = await c.env.DB.prepare(
      `SELECT salon_key FROM salonboard_salons WHERE user_id = ? AND is_active_workspace = 1`
    )
      .bind(user.id)
      .all<{ salon_key: string | null }>()
    const activeKeys = new Set((activeRows || []).map((r) => r.salon_key))

    // キレイサロン向けダッシュボードは現時点で未対応のため、追加候補には出さない。
    const available = allSalons.filter((s) => !activeKeys.has(s.storeId) && s.type !== 'kirei')
    return c.json({ success: true, salons: available })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err).slice(0, 2000) }, 400)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

// 複数サロンワークスペース対応 フェーズ4: 選ばれた追加サロンを有効化する。
// active_salon_idは変更しない(選んだだけではまだ切り替わらず、別途
// サロン切り替えボタンで切り替える)。
dashboard.post('/api/settings/activate-additional-salon', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const storeId = String(body.storeId || '').trim()
  if (!storeId) return c.json({ success: false, error: 'storeIdが指定されていません' }, 400)

  const slotRow = await c.env.DB.prepare(
    `SELECT salon_slot_limit,
       (SELECT COUNT(*) FROM salonboard_salons WHERE user_id = ? AND is_active_workspace = 1) AS active_count
     FROM users WHERE id = ?`
  )
    .bind(user.id, user.id)
    .first<{ salon_slot_limit: number; active_count: number }>()
  if (!slotRow || slotRow.active_count >= slotRow.salon_slot_limit) {
    return c.json({ success: false, error: '追加できるサロンの枠がありません。管理者にお問い合わせください' }, 400)
  }

  const salon = await c.env.DB.prepare(
    'SELECT id, is_active_workspace FROM salonboard_salons WHERE user_id = ? AND salon_key = ?'
  )
    .bind(user.id, storeId)
    .first<{ id: number; is_active_workspace: number }>()
  if (!salon) return c.json({ success: false, error: '指定されたサロンが見つかりません' }, 400)
  if (salon.is_active_workspace === 1) {
    return c.json({ success: false, error: 'このサロンは既に有効化されています' }, 400)
  }

  await c.env.DB.prepare(
    `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(salon.id)
    .run()

  return c.json({ success: true })
})

// 複数サロンワークスペース対応 フェーズ4: サロン切り替え。
// 複数サロンワークスペース対応 フェーズ4: サイドバーのサロン切り替えUIが
// 使う軽量API。有効化済みワークスペースが1件以下(大多数のアカウント)の
// 場合は空配列を返し、クライアント側は何も描画しない。
dashboard.get('/api/settings/active-salons', async (c) => {
  const user = c.get('user')
  const { results } = await c.env.DB.prepare(
    `SELECT id, salon_name, salon_type FROM salonboard_salons
     WHERE user_id = ? AND is_active_workspace = 1 ORDER BY id ASC`
  )
    .bind(user.id)
    .all<{ id: number; salon_name: string; salon_type: string | null }>()

  return c.json({
    success: true,
    activeSalonId: user.active_salon_id,
    salons: (results || []).map((s) => ({ id: s.id, name: s.salon_name, type: s.salon_type || 'hair' }))
  })
})

dashboard.post('/api/settings/switch-salon', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const salonId = Number(body.salonId)
  if (!Number.isFinite(salonId)) return c.json({ success: false, error: 'salonIdが指定されていません' }, 400)

  const salon = await c.env.DB.prepare(
    'SELECT id, salon_key FROM salonboard_salons WHERE id = ? AND user_id = ? AND is_active_workspace = 1'
  )
    .bind(salonId, user.id)
    .first<{ id: number; salon_key: string | null }>()
  if (!salon) return c.json({ success: false, error: '指定されたサロンが見つかりません' }, 400)

  await c.env.DB.prepare('UPDATE users SET active_salon_id = ? WHERE id = ?').bind(salonId, user.id).run()
  // 重大バグ修正: target_store_idをactive_salon_idに追随させないと、次回の
  // 「サロンボードと同期する」実行時にブラウザが切り替え前のサロンへログイン
  // し続けてしまい、切り替え後のサロンに他サロンのデータが同期されてしまう。
  if (salon.salon_key) {
    await c.env.DB.prepare('UPDATE salon_credentials SET target_store_id = ? WHERE user_id = ?')
      .bind(salon.salon_key, user.id)
      .run()
  }
  return c.json({ success: true })
})

function maskLoginId(loginId: string): string {
  if (loginId.length <= 2) return '*'.repeat(loginId.length)
  const visible = loginId.slice(0, 2)
  return visible + '*'.repeat(Math.max(loginId.length - 2, 3))
}

export default dashboard
