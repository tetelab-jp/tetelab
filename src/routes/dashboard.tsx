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
import { BLACKOUT_START_LABEL, BLACKOUT_END_LABEL, POST_INTERVAL_MINUTES_LABEL } from './style'
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
    'SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE auto_post_enabled_flag = 1) as auto_post_on FROM blog_articles WHERE user_id = ? AND salon_id = ?'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ total: number; auto_post_on: number }>()

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

      reviewEnabled={user.review_enabled !== 0}
      active="dashboard"
      salonName={user.salon_name}
      title="ダッシュボード"
      styleEnabled={user.style_enabled !== 0}
      blogEnabled={user.blog_enabled !== 0}
    >
      {activeSalonInfo?.salon_name && (
        <div class="flex items-center gap-2 min-w-0">
          <i class="fas fa-shop text-pink-500 text-sm md:text-lg flex-shrink-0"></i>
          <h2 class="text-sm md:text-2xl font-bold text-gray-900 break-words md:truncate">{activeSalonInfo.salon_name}</h2>
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

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            カテゴリ別テンプレートで画像から記事をAI生成し、自動投稿できます。
          </p>
          <a href="/blog/articles" class="text-sm font-semibold text-pink-600 hover:underline">
            投稿記事一覧を開く <i class="fas fa-arrow-right ml-1"></i>
          </a>
        </div>
        <div class="bg-white rounded-xl border border-gray-100 p-5">
          <p class="font-semibold mb-2">
            <i class="fas fa-list-check mr-2 text-pink-500"></i>対策キーワード設定
          </p>
          <p class="text-sm text-gray-600 mb-3">
            上位表示を狙うキーワードを登録し、定期的に検索順位を測定できます。
          </p>
          <a href="/seo/keywords" class="text-sm font-semibold text-pink-600 hover:underline">
            対策キーワード設定を開く <i class="fas fa-arrow-right ml-1"></i>
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
          <p class="text-xs text-gray-400 mb-1">ブログ記事（自動投稿ON/総数）</p>
          <p class="text-lg font-bold text-gray-800">
            {blogArticlesRow?.auto_post_on ?? 0} / {blogArticlesRow?.total ?? 0} 件
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

      reviewEnabled={user.review_enabled !== 0}
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

      reviewEnabled={user.review_enabled !== 0}
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

      <div class="max-w-2xl space-y-6">
        <div>
          <div id="email-edit-trigger" class={`bg-white rounded-xl border border-gray-100 p-6 flex items-center justify-between gap-4 flex-wrap ${error ? 'hidden' : ''}`}>
            <div>
              <p class="font-semibold">
                <i class="fas fa-envelope mr-2 text-pink-500"></i>メールアドレスの変更
              </p>
              <p class="text-xs text-gray-500 mt-1">現在のメールアドレス: {user.email}</p>
            </div>
            <button
              type="button"
              id="email-edit-open-btn"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-5 py-2 rounded-lg text-sm flex-shrink-0"
            >
              変更する
            </button>
          </div>

          <form
            id="email-edit-form"
            method="post"
            action="/settings/account/email"
            autocomplete="off"
            class={`bg-white rounded-xl border border-gray-100 p-6 space-y-4 ${error ? '' : 'hidden'}`}
          >
            <p class="font-semibold">
              <i class="fas fa-envelope mr-2 text-pink-500"></i>メールアドレスの変更
            </p>
            <p class="text-xs text-gray-500 leading-relaxed">現在のメールアドレス: {user.email}</p>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">新しいメールアドレス</label>
              <input
                required
                type="email"
                name="new_email"
                autocomplete="off"
                placeholder="新しいメールアドレスを入力"
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
              メールアドレスを変更する
            </button>
          </form>
        </div>

        <div>
          <div id="password-edit-trigger" class={`bg-white rounded-xl border border-gray-100 p-6 flex items-center justify-between gap-4 flex-wrap ${error ? 'hidden' : ''}`}>
            <div>
              <p class="font-semibold">
                <i class="fas fa-key mr-2 text-pink-500"></i>パスワードの変更
              </p>
              <a href="/forgot-password" class="text-xs text-pink-600 hover:underline">パスワードを忘れた場合はこちら</a>
            </div>
            <button
              type="button"
              id="password-edit-open-btn"
              class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-5 py-2 rounded-lg text-sm flex-shrink-0"
            >
              変更する
            </button>
          </div>

          <form
            id="password-edit-form"
            method="post"
            action="/settings/account/password"
            autocomplete="off"
            class={`bg-white rounded-xl border border-gray-100 p-6 space-y-4 ${error ? '' : 'hidden'}`}
          >
            <div class="flex items-center justify-between flex-wrap gap-2">
              <p class="font-semibold">
                <i class="fas fa-key mr-2 text-pink-500"></i>パスワードの変更
              </p>
              <a href="/forgot-password" class="text-xs text-pink-600 hover:underline">パスワードを忘れた場合はこちら</a>
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1">新しいパスワード</label>
              <input
                required
                type="password"
                name="new_password"
                autocomplete="new-password"
                placeholder="8文字以上で入力"
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
              パスワードを変更する
            </button>
          </form>
        </div>
      </div>

      <script src="/static/account-settings.js"></script>
    </PageLayout>,
    { title: 'アカウント設定' }
  )
})

dashboard.post('/settings/account/email', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const newEmail = String(body.new_email || '').trim().toLowerCase()
  const currentPassword = String(body.current_password || '')

  const redirectError = (message: string) => c.redirect('/settings/account?error=' + encodeURIComponent(message))

  if (!newEmail) {
    return redirectError('新しいメールアドレスを入力してください')
  }

  const current = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>()
  const passwordOk = await verifyPasswordConstantTime(currentPassword, current?.password_hash ?? null)
  if (!passwordOk) {
    return redirectError('現在のパスワードが正しくありません')
  }

  if (newEmail !== user.email) {
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

  return c.redirect('/settings/account?saved=1')
})

dashboard.post('/settings/account/password', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const newPassword = String(body.new_password || '')
  const currentPassword = String(body.current_password || '')

  const redirectError = (message: string) => c.redirect('/settings/account?error=' + encodeURIComponent(message))

  if (!newPassword || newPassword.length < 8) {
    return redirectError('新しいパスワードは8文字以上で入力してください')
  }

  const current = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?')
    .bind(user.id)
    .first<{ password_hash: string }>()
  const passwordOk = await verifyPasswordConstantTime(currentPassword, current?.password_hash ?? null)
  if (!passwordOk) {
    return redirectError('現在のパスワードが正しくありません')
  }

  const passwordHash = await hashPassword(newPassword)
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(passwordHash, user.id)
    .run()

  return c.redirect('/settings/account?saved=1')
})

// ---------- 自動更新設定 ----------
// 2026-08-16追記(ユーザー指定): ①スタイル投稿の自動投稿・手動投稿(旧/style/schedule)、
// ②ブログ投稿記事一覧のSALON BOARDへの自動投稿(旧/blog/articlesに埋め込み)、
// ③SEOの定期測定設定(旧/seo/schedule)の3つを1ページに統合する。
// 各セクションのフォームは既存のaction先(/style/schedule等)へそのままPOSTし、
// 保存後の戻り先だけをこのページに変更している(DBロジック・機能フラグ制御は変更なし)。

// 3カテゴリ(スタイル投稿/ブログ投稿/SEO)を同一の見た目のルール(色付きアイコン
// バッジ付きヘッダー+はっきりした枠線を持つ1枚のカード)で統一して並べるための
// 共通ラッパー。カテゴリごとの識別はcolorClasses(アイコンバッジの配色)のみで行う。
function AutoUpdateSection({
  icon,
  colorClasses,
  title,
  children
}: {
  icon: string
  colorClasses: string
  title: string
  children: any
}) {
  return (
    <div class="bg-white rounded-xl border-2 border-gray-100 overflow-hidden">
      <div class="flex items-center gap-3 px-6 py-4 border-b-2 border-gray-100">
        <span class={'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ' + colorClasses}>
          <i class={`fas ${icon}`}></i>
        </span>
        <p class="font-bold text-gray-800">{title}</p>
      </div>
      <div class="p-6 space-y-4">{children}</div>
    </div>
  )
}

dashboard.get('/settings/auto-update', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')
  const clearedCount = c.req.query('cleared')
  const salonId = user.active_salon_id

  const styleEnabled = user.style_enabled !== 0
  const blogEnabled = user.blog_enabled !== 0
  const seoEnabled = user.seo_enabled !== 0

  const styleSchedule = styleEnabled
    ? await c.env.DB.prepare(
        'SELECT enabled, burst_remaining, paused_until FROM style_post_schedules WHERE user_id = ? AND salon_id = ?'
      )
        .bind(user.id, salonId)
        .first<{ enabled: number; burst_remaining: number; paused_until: string | null }>()
    : null
  const styleEnabledOn = styleSchedule?.enabled === 1
  const styleIsPaused =
    !!styleSchedule?.paused_until && new Date(styleSchedule.paused_until.replace(' ', 'T') + 'Z').getTime() > Date.now()
  const styleIsBursting = styleEnabledOn && (styleSchedule?.burst_remaining ?? 0) > 0
  const styleSelectedRow = styleEnabled
    ? await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND salon_id = ? AND auto_post_enabled_flag = 1 AND internal_save_status = 'ready'"
      )
        .bind(user.id, salonId)
        .first<{ cnt: number }>()
    : null
  const styleSelectedCount = styleSelectedRow?.cnt ?? 0

  const blogSchedule = blogEnabled
    ? await c.env.DB.prepare(`SELECT enabled, paused_until FROM blog_post_schedules WHERE user_id = ? AND salon_id = ?`)
        .bind(user.id, salonId)
        .first<{ enabled: number; paused_until: string | null }>()
    : null
  const blogScheduleEnabled = blogSchedule?.enabled === 1
  const blogPausedUntilMs = blogSchedule?.paused_until
    ? new Date(blogSchedule.paused_until.replace(' ', 'T') + 'Z').getTime()
    : null
  const blogIsPaused = !!blogPausedUntilMs && blogPausedUntilMs > Date.now()
  const inFlightBlogJob = blogEnabled
    ? await c.env.DB.prepare(
        `SELECT 1 as x FROM blog_post_jobs WHERE user_id = ? AND salon_id = ? AND status IN ('pending', 'running') LIMIT 1`
      )
        .bind(user.id, salonId)
        .first<{ x: number }>()
    : null

  const rankingSchedule = seoEnabled
    ? await c.env.DB.prepare(
        `SELECT enabled, frequency, run_time, last_run_at FROM ranking_schedules WHERE user_id = ? AND salon_id = ?`
      )
        .bind(user.id, salonId)
        .first<{ enabled: number; frequency: string; run_time: string | null; last_run_at: string | null }>()
    : null
  const rankingEnabledOn = rankingSchedule?.enabled === 1
  const rankingLastRunAt = rankingSchedule?.last_run_at || null

  return c.render(
    <PageLayout
      seoEnabled={seoEnabled}
      reviewEnabled={user.review_enabled !== 0}
      active="auto-update"
      salonName={user.salon_name}
      title="自動更新設定"
      styleEnabled={styleEnabled}
      blogEnabled={blogEnabled}
    >
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}
      {clearedCount !== undefined && (
        <div class="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>
          {clearedCount === '0'
            ? '古い進行中ジョブは見つかりませんでした(15分未満のジョブは対象外です)'
            : `${clearedCount}件の古い進行中ジョブをリセットしました`}
        </div>
      )}

      {styleEnabled && (
        <AutoUpdateSection icon="fa-images" colorClasses="bg-pink-100 text-pink-600" title="スタイル投稿">
          <div>
            <p class="text-xs font-semibold text-gray-400 mb-2">自動投稿</p>
            <form method="post" action="/style/schedule" class="bg-gray-50 rounded-lg p-4">
              <label class="flex items-center gap-3 cursor-pointer w-fit">
                <span class="relative inline-flex items-center flex-shrink-0">
                  <input
                    type="checkbox"
                    name="enabled"
                    checked={styleEnabledOn}
                    onchange="this.form.submit()"
                    class="sr-only peer"
                  />
                  <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
                  <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
                </span>
                <span class="text-sm font-medium text-gray-700">
                  自動投稿を有効にする（{POST_INTERVAL_MINUTES_LABEL}分おきに1件、深夜{BLACKOUT_START_LABEL}〜{BLACKOUT_END_LABEL}は停止）
                </span>
              </label>
            </form>
          </div>

          {styleIsPaused && (
            <div class="bg-red-50 border border-red-200 rounded-xl p-5 text-sm text-red-700 flex items-center justify-between gap-4 flex-wrap">
              <span>
                <i class="fas fa-triangle-exclamation mr-2"></i>
                5件連続で投稿が失敗したため、自動投稿を一時停止しています。5時間経過後に自動的に再開します。
              </span>
              <form method="post" action="/style/schedule/clear-pause">
                <button type="submit" class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-white border border-red-300 text-red-700 hover:bg-red-100">
                  今すぐ再開する
                </button>
              </form>
            </div>
          )}

          {!styleIsPaused && styleIsBursting && (
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
              <i class="fas fa-bolt mr-2"></i>
              自動投稿を有効にした直後の動作確認として、登録順の先頭3件を間隔を空けず連続投稿しています
              （残り{styleSchedule?.burst_remaining}件）。完了後は通常運転（{POST_INTERVAL_MINUTES_LABEL}分おきに1件）に移ります。
            </div>
          )}

          <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
            <i class="fas fa-circle-info mr-2"></i>
            自動投稿を有効にすると自動投稿対象のスタイルを登録順に{POST_INTERVAL_MINUTES_LABEL}分おきに1件ずつ「登録＋反映申請」まで自動実行します。
            <br />
            ※深夜{BLACKOUT_START_LABEL}〜{BLACKOUT_END_LABEL}を除く時間帯
            <br />
            現在<b>{styleSelectedCount}件</b>が対象です。
          </div>

          <div>
            <p class="text-xs font-semibold text-gray-400 mb-2">手動投稿</p>
            <div class="bg-gray-50 rounded-lg p-4">
              {user.is_impersonated === 1 && (
                <>
                  <button
                    id="test-run-btn"
                    class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
                  >
                    <i class="fas fa-flask mr-2"></i>手動実行する(なりすましログイン中のみ)
                  </button>
                  <p id="test-run-status" class="text-sm text-gray-500 mt-3"></p>
                </>
              )}
              <form method="post" action="/style/schedule/reset-stuck-jobs" class={user.is_impersonated === 1 ? 'mt-3' : ''}>
                <button type="submit" class="text-xs text-gray-400 hover:text-gray-600 underline">
                  「投稿対象のスタイルがありません」等が出続ける場合、15分以上停滞している進行中ジョブをリセットする
                </button>
              </form>
            </div>
          </div>

          {user.is_impersonated === 1 && (
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
              <i class="fas fa-triangle-exclamation mr-2"></i>
              手動実行ボタンを押すと、現在自動投稿対象で入力完了済みのスタイルすべてに対して実際に
              サロンボードへの<b>登録＋反映申請（公開）</b>が実行されます。パスワードは画面・ログのどこにも表示されません。
              実行はAWS側のジョブとして非同期に行われるため、結果は完了次第、順次<a href="/style/test-run" class="underline font-semibold">実行履歴</a>に反映されます（数十秒〜数分かかります）。
            </div>
          )}
        </AutoUpdateSection>
      )}

      {blogEnabled && (
        <AutoUpdateSection icon="fa-newspaper" colorClasses="bg-blue-100 text-blue-600" title="ブログ投稿">
          <div>
            <p class="text-xs font-semibold text-gray-400 mb-2">自動投稿</p>
            <form method="post" action="/blog/articles/schedule" class="bg-gray-50 rounded-lg p-4">
              <label class="flex items-center gap-3 cursor-pointer w-fit">
                <span class="relative inline-flex items-center flex-shrink-0">
                  <input type="checkbox" name="enabled" checked={blogScheduleEnabled} onchange="this.form.submit()" class="sr-only peer" />
                  <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
                  <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
                </span>
                <span class="text-sm font-medium text-gray-700">
                  自動投稿を有効にする（SALON BOARDへ、月タグに合う記事を1日1本の目安で自動投稿。深夜2:00〜7:00は停止）
                </span>
              </label>
            </form>
          </div>

          {blogIsPaused && (
            <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
              <i class="fas fa-triangle-exclamation mr-2"></i>
              連続で投稿に失敗したため、一時的に自動投稿を停止しています(しばらくすると自動的に再開します)。
            </div>
          )}

          {user.is_impersonated === 1 && (
            <div>
              <p class="text-xs font-semibold text-gray-400 mb-2">手動投稿(なりすましログイン中のみ)</p>
              <div class="bg-gray-50 rounded-lg p-4">
                <button type="button" id="blog-test-run-btn" class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50" disabled={!!inFlightBlogJob}>
                  <i class="fas fa-flask mr-2"></i>今すぐまとめて投稿する
                </button>
                {inFlightBlogJob && <p class="text-xs text-gray-400 mt-3">投稿処理が進行中です...</p>}
                <p id="blog-test-run-status" class="text-sm text-gray-500 mt-3"></p>
              </div>
            </div>
          )}
        </AutoUpdateSection>
      )}

      {seoEnabled && (
        <AutoUpdateSection icon="fa-magnifying-glass-chart" colorClasses="bg-amber-100 text-amber-600" title="SEO">
          <div class="bg-gray-50 rounded-lg p-4">
            <p class="text-sm font-semibold text-gray-700 mb-2">定期測定設定</p>
            <p class="text-sm text-gray-500 mb-2">
              「対策キーワード設定」に登録した条件を、毎週月曜日の夜20時に自動計測します。
            </p>
            <p class="text-xs text-gray-400 mb-4">
              前回の定期実行：{rankingLastRunAt ? formatJstDateTime(rankingLastRunAt) : 'なし'}
            </p>
            <form method="post" action="/seo/schedule">
              <label class="flex items-center gap-3 cursor-pointer w-fit">
                <span class="relative inline-flex items-center flex-shrink-0">
                  <input
                    type="checkbox"
                    name="enabled"
                    value="1"
                    checked={rankingEnabledOn}
                    onchange="this.form.submit()"
                    class="sr-only peer"
                  />
                  <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
                  <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
                </span>
                <span class="text-sm font-medium text-gray-700">定期測定を有効にする（毎週月曜 20:00）</span>
              </label>
            </form>
          </div>
        </AutoUpdateSection>
      )}

      <script src="/static/auto-update.js"></script>
    </PageLayout>,
    { title: '自動更新設定' }
  )
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
      // 2026-08-17追記(至急・重大バグ修正): 従来はis_active_workspaceを常に1へ
      // 無条件でUPDATEしていたため、管理者サイト(/admin/salons)が明示的に
      // 無効化(is_active_workspace=0)したサロンでも、利用者が通常の「サロンボード
      // と同期する」操作をするたびに勝手に有効化へ戻ってしまっていた。
      // activated_at IS NULL(=一度も有効化されたことが無い、真の初回)の場合のみ
      // 有効化する。一度でも有効化された(activated_atが立っている)行は、その後
      // 管理者が無効化した可能性があるため、ここでは触らない。
      await c.env.DB.prepare(
        `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND salon_key = ? AND activated_at IS NULL`
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
        // キレイサロン(ネイル/まつげ等)にはスタイル機能が存在しないため無効化する。
        // 2026-08-17追記(至急・バグ修正): 2026-08-16のサロン単位化以降、実際の機能
        // ゲート判定はsalonboard_salons.style_enabled(サロン単位)のみを見ており、
        // users.style_enabled(アカウント単位)は既に参照されなくなっていた。この
        // ままではキレイサロンでもスタイル機能が使えてしまうため、対象サロンの
        // salonboard_salons側を無効化するよう修正する。
        await c.env.DB.prepare(
          'UPDATE salonboard_salons SET style_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_key = ?'
        )
          .bind(user.id, groupTopResult.storeId)
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
    // 診断ログ(URL・画面テキスト等)はCloudWatch Logsのみに残し、画面には
    // 出さない(内部の生デバッグ情報がそのまま表示されるのを防ぐため)。
    console.error(`[sync-stylists-coupons] user=${user.id} エラー:`, err?.stack || err)
    if (logLines.length > 0) console.error(`[sync-stylists-coupons] user=${user.id} 診断ログ: ${logLines.join(' | ')}`)
    return c.json({ success: false, error: String(err?.message || err).slice(0, 500) }, 400)
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

  // 2026-08-17追記(至急・重大バグ修正): dashboard.tsx内の同種のUPDATEと同じ理由で、
  // 管理者サイトが明示的に無効化したサロンを勝手に再有効化しないよう、真の初回
  // (activated_at IS NULL)の場合のみ有効化する。
  await c.env.DB.prepare(
    `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = CURRENT_TIMESTAMP
     WHERE user_id = ? AND salon_key = ? AND activated_at IS NULL`
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
    // 2026-08-17追記(至急・バグ修正): dashboard.tsx内の同種の箇所と同じ理由で、
    // 参照されなくなったusers.style_enabledではなく、対象サロンのsalonboard_salons
    // 側を無効化する。
    await c.env.DB.prepare(
      'UPDATE salonboard_salons SET style_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_key = ?'
    )
      .bind(user.id, storeId)
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
    'SELECT id, is_active_workspace, activated_at FROM salonboard_salons WHERE user_id = ? AND salon_key = ?'
  )
    .bind(user.id, storeId)
    .first<{ id: number; is_active_workspace: number; activated_at: string | null }>()
  if (!salon) return c.json({ success: false, error: '指定されたサロンが見つかりません' }, 400)
  if (salon.is_active_workspace === 1) {
    return c.json({ success: false, error: 'このサロンは既に有効化されています' }, 400)
  }
  // 2026-08-17追記(至急・重大バグ修正): このエンドポイントだけ、他の全ての有効化
  // 箇所(dashboard.tsx内の同期箇所・select-salon・admin.tsxのtoggle-workspace)と
  // 異なり「真の初回(activated_at IS NULL)のみ有効化する」ガードが無かった。
  // このため、管理者が/admin/salonsで明示的に無効化したサロンでも、利用者が
  // このAPI(追加サロン選択画面)から選び直すだけで、管理者の操作を無視して
  // 勝手に再有効化できてしまっていた(salon_slot_limitは有効化するたびに増加する
  // のみで減らないため、一度でも有効化されたことがあるサロンは枠を使い切って
  // いない限りいつでも再有効化できてしまう)。他の箇所と同じガードを追加する。
  if (salon.activated_at) {
    return c.json(
      { success: false, error: 'このサロンは管理者により無効化されています。有効化については管理者にお問い合わせください' },
      400
    )
  }

  await c.env.DB.prepare(
    `UPDATE salonboard_salons SET is_active_workspace = 1, activated_at = CURRENT_TIMESTAMP WHERE id = ? AND activated_at IS NULL`
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
