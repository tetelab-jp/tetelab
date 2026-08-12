import { Hono, type Context } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { decryptSecret } from '../lib/crypto'
import { launchBrowser, newAutomationPage, loginToSalonBoard } from '../lib/salonboard-automation'
import { fetchExistingStyles, importSelectedStyles } from '../lib/salonboard-import'
import type { Bindings, AppUser } from '../types'

type AppContext = Context<{ Bindings: Bindings; Variables: { user: AppUser } }>

const style = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

style.use('*', requireAuth)

// ---------- 共通ヘルパー ----------

const HAIR_LENGTH_OPTIONS = {
  SG01: [
    ['HL05', 'ベリーショート'],
    ['HL04', 'ショート'],
    ['HL03', 'ミディアム'],
    ['HL02', 'セミロング'],
    ['HL01', 'ロング'],
    ['HL08', 'ヘアセット'],
    ['HL07', 'ミセス']
  ],
  SG02: [
    ['HL09', 'ボウズ'],
    ['HL10', 'ベリーショート'],
    ['HL11', 'ショート'],
    ['HL12', 'ミディアム'],
    ['HL13', 'ロング'],
    ['HL06', 'その他']
  ]
} as const

const MENU_OPTIONS: [string, string][] = [
  ['MC01', 'パーマ'],
  ['MC02', 'ストレートパーマ・縮毛矯正'],
  ['MC03', 'エクステ'],
  ['MC04', 'ブリーチ']
]

// モデル属性(docs/phase3-mvp-design.md 4-6参照。frmStyleEditStyleModelDto.*)。
// 髪量/髪質/太さ/クセの1〜3の具体的な表示文言はSALON BOARD実HTML上では
// コード値(1〜3)のみ確認済みで、正式なラベル文言は未確認のため暫定表記。
const MODEL_SCALE_OPTIONS: Record<string, [string, string][]> = {
  hairVolume: [
    ['99', '設定しない'],
    ['1', '少なめ'],
    ['2', '普通'],
    ['3', '多め']
  ],
  hairQuality: [
    ['99', '設定しない'],
    ['1', '柔らかめ'],
    ['2', '普通'],
    ['3', '硬め']
  ],
  hairThickness: [
    ['99', '設定しない'],
    ['1', '細め'],
    ['2', '普通'],
    ['3', '太め']
  ],
  curl: [
    ['99', '設定しない'],
    ['1', '少なめ'],
    ['2', '普通'],
    ['3', '強め']
  ]
}

const MODEL_FACE_TYPE_OPTIONS: [string, string][] = [
  ['99', '設定しない'],
  ['4', '逆三角'],
  ['1', '丸型'],
  ['5', 'ベース'],
  ['2', '卵型'],
  ['6', '面長'],
  ['3', '四角']
]

const MODEL_AGE_OPTIONS: [string, string][] = [
  ['99', '設定しない'],
  ['0', 'キッズ'],
  ['1', '10代'],
  ['2', '20代'],
  ['3', '30代'],
  ['4', '40代'],
  ['5', '50代'],
  ['6', '60代以上']
]

type ModelAttributes = {
  hairVolume?: string
  hairQuality?: string
  hairThickness?: string
  curl?: string
  faceType?: string
  age?: string
}

function ModelAttributeFields({ model }: { model: ModelAttributes }) {
  return (
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">モデル情報(任意)</label>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div>
          <label class="block text-xs text-gray-500 mb-1">髪量</label>
          <select name="model_hair_volume" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_SCALE_OPTIONS.hairVolume.map(([v, label]) => (
              <option value={v} selected={(model.hairVolume || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">髪質</label>
          <select name="model_hair_quality" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_SCALE_OPTIONS.hairQuality.map(([v, label]) => (
              <option value={v} selected={(model.hairQuality || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">太さ</label>
          <select name="model_hair_thickness" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_SCALE_OPTIONS.hairThickness.map(([v, label]) => (
              <option value={v} selected={(model.hairThickness || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">クセ</label>
          <select name="model_curl" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_SCALE_OPTIONS.curl.map(([v, label]) => (
              <option value={v} selected={(model.curl || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">顔型</label>
          <select name="model_face_type" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_FACE_TYPE_OPTIONS.map(([v, label]) => (
              <option value={v} selected={(model.faceType || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-xs text-gray-500 mb-1">年代</label>
          <select name="model_age" class="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
            {MODEL_AGE_OPTIONS.map(([v, label]) => (
              <option value={v} selected={(model.age || '99') === v}>{label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  )
}

function parseModelAttributesForm(body: Record<string, any>): ModelAttributes {
  const pick = (key: string) => {
    const v = String(body[key] || '99')
    return v && v !== '99' ? v : undefined
  }
  const model: ModelAttributes = {
    hairVolume: pick('model_hair_volume'),
    hairQuality: pick('model_hair_quality'),
    hairThickness: pick('model_hair_thickness'),
    curl: pick('model_curl'),
    faceType: pick('model_face_type'),
    age: pick('model_age')
  }
  return model
}

// <script type="application/json">に埋め込むためのJSON文字列化。
// テンプレート名等のユーザー入力に"</script"が含まれていてもタグを閉じさせないよう'<'をエスケープする。
function jsonForScriptTag(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function statusBadge(status: string, kind: 'internal' | 'register' | 'reflection') {
  // 2026-08-09追記: 「公開済み/ブロック」の2値表示だと、まだ一度も実行して
  // いない(not_started)スタイルや、ブロックとは無関係の単純な失敗(failed)まで
  // 「ブロック」表示になってしまい、「本当にブロックされているのか」が
  // 分からなくなる問題があった(ユーザー指摘)。実際にサロンボード側の
  // 「要確認」等でブロックされた場合(blocked)のみ「ブロック」とし、
  // それ以外は状態ごとに分けて表示する。
  if (kind === 'reflection') {
    if (status === 'success') {
      return <span class="text-xs px-2 py-0.5 rounded font-semibold bg-green-50 text-green-600">公開済み</span>
    }
    if (status === 'blocked') {
      return <span class="text-xs px-2 py-0.5 rounded font-semibold bg-red-50 text-red-600">ブロック</span>
    }
    if (status === 'failed') {
      return <span class="text-xs px-2 py-0.5 rounded font-semibold bg-amber-50 text-amber-600">失敗</span>
    }
    return <span class="text-xs px-2 py-0.5 rounded font-semibold bg-gray-100 text-gray-500">未実行</span>
  }

  const map: Record<string, string> = {
    draft: 'bg-gray-100 text-gray-500',
    ready: 'bg-blue-50 text-blue-600',
    disabled: 'bg-gray-100 text-gray-400',
    not_started: 'bg-gray-100 text-gray-500',
    success: 'bg-green-50 text-green-600',
    failed: 'bg-red-50 text-red-600',
    pending: 'bg-amber-50 text-amber-600',
    blocked: 'bg-red-50 text-red-600'
  }
  const label: Record<string, string> = {
    draft: '未完成',
    ready: '準備完了',
    disabled: '停止中',
    not_started: '未実行',
    success: '成功',
    failed: '失敗',
    pending: '反映申請待ち',
    blocked: 'ブロック'
  }
  return (
    <span class={'text-xs px-2 py-0.5 rounded font-semibold ' + (map[status] || 'bg-gray-100 text-gray-500')}>
      {label[status] || status}
    </span>
  )
}

// ---------- スタイル一覧 ----------

type StyleListRow = {
  id: number
  title: string | null
  category_value: string | null
  length_value: string | null
  auto_post_enabled_flag: number
  internal_save_status: string
  salonboard_register_status: string
  reflection_request_status: string
  stylist_name: string | null
  front_style_image_id: number | null
}

async function loadStyleListForUser(c: AppContext, user: AppUser): Promise<StyleListRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT
       s.id, s.title, s.category_value, s.length_value, s.auto_post_enabled_flag,
       s.internal_save_status, s.salonboard_register_status, s.reflection_request_status,
       st.name AS stylist_name,
       si.id AS front_style_image_id
     FROM styles s
     LEFT JOIN stylists st ON st.id = s.stylist_id
     LEFT JOIN style_images si ON si.style_id = s.id AND si.image_role = 'FRONT'
     WHERE s.user_id = ?
     ORDER BY s.sort_order ASC, s.id DESC`
  )
    .bind(user.id)
    .all<StyleListRow>()
  return results || []
}

function StyleListSection({
  styles,
  totalCount,
  selectedCount,
  showCreateLink = true
}: {
  styles: StyleListRow[]
  totalCount: number
  selectedCount: number
  showCreateLink?: boolean
}) {
  return (
    <>
      <div class="flex items-center justify-between flex-wrap gap-2">
        <p class="font-semibold">
          <i class="fas fa-portrait mr-2 text-pink-500"></i>登録済みスタイル（{totalCount}件）
        </p>
        <div class="flex items-center gap-3">
          <span class="text-sm text-gray-600">
            投稿対象:{' '}
            <span id="selected-count" class="font-bold text-pink-600">
              {selectedCount}
            </span>{' '}
            / {totalCount} 件
          </span>
          <button
            id="select-all-btn"
            type="button"
            class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-2 py-1"
          >
            全選択
          </button>
          <button
            id="deselect-all-btn"
            type="button"
            class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-2 py-1"
          >
            全解除
          </button>
          {showCreateLink && (
            <a
              href="/style/new"
              class="bg-pink-500 hover:bg-pink-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
            >
              <i class="fas fa-plus mr-1"></i>新規作成
            </a>
          )}
        </div>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        {styles.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-10">
            まだスタイルが登録されていません。「新規作成」から追加してください。
          </p>
        ) : (
          <>
            <div class="hidden md:flex items-center gap-4 pb-2 border-b border-gray-100 text-xs font-semibold text-gray-400">
              <span class="w-8 flex-shrink-0 text-center">No</span>
              <span class="w-5 flex-shrink-0"></span>
              <span class="w-20 flex-shrink-0">画像</span>
              <span class="flex-1 min-w-0">スタイル名 / スタイリスト</span>
              <span class="flex-shrink-0">操作</span>
            </div>
            <div id="style-list" class="divide-y divide-gray-100">
            {styles.map((s, idx) => (
              <div class="flex items-center gap-2 md:gap-4 py-1.5 md:py-3" data-image-id={s.id}>
                <span class="hidden md:block w-8 flex-shrink-0 text-center text-xs text-gray-400">{idx + 1}</span>
                <input
                  type="checkbox"
                  class="style-checkbox w-4 h-4 md:w-5 md:h-5 accent-pink-500 cursor-pointer flex-shrink-0"
                  checked={s.auto_post_enabled_flag === 1}
                  data-image-id={s.id}
                />
                <a href={`/style/${s.id}/edit`} class="flex-shrink-0">
                  {s.front_style_image_id ? (
                    <img
                      src={`/style/image/${s.front_style_image_id}`}
                      class="w-10 h-14 md:w-20 md:h-28 object-contain bg-gray-50 rounded-lg border border-gray-200"
                      loading="lazy"
                    />
                  ) : (
                    <div class="w-10 h-14 md:w-20 md:h-28 bg-gray-50 rounded-lg border border-gray-200 flex items-center justify-center text-gray-300">
                      <i class="fas fa-image text-xl"></i>
                    </div>
                  )}
                </a>
                <div class="flex-1 min-w-0">
                  <a href={`/style/${s.id}/edit`} class="block truncate font-medium text-gray-700 hover:text-pink-600">
                    {s.title || '（無題）'}
                  </a>
                  <p class="text-xs text-gray-400 mt-0.5">{s.stylist_name || '担当未設定'}</p>
                  <div class="flex flex-wrap gap-1 mt-1">
                    {statusBadge(s.internal_save_status, 'internal')}
                    {statusBadge(s.reflection_request_status, 'reflection')}
                  </div>
                </div>
                <div class="flex items-center gap-1 md:gap-2 flex-shrink-0">
                  <a
                    href={`/style/${s.id}/edit`}
                    class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded w-8 h-8 md:w-auto md:h-auto flex items-center justify-center md:px-3 md:py-1.5"
                  >
                    <i class="fas fa-pen md:mr-1"></i>
                    <span class="hidden md:inline">編集</span>
                  </a>
                  <button
                    type="button"
                    class="delete-btn text-xs font-semibold text-red-500 hover:bg-red-50 border border-red-200 rounded w-8 h-8 md:w-auto md:h-auto flex items-center justify-center md:px-3 md:py-1.5"
                    data-image-id={s.id}
                    title="削除"
                  >
                    <i class="fas fa-xmark md:mr-1"></i>
                    <span class="hidden md:inline">削除</span>
                  </button>
                </div>
              </div>
            ))}
            </div>
          </>
        )}
      </div>
    </>
  )
}

function TemplateBulkApplySection({
  templates,
  hasStyles
}: {
  templates: { id: number; template_name: string }[]
  hasStyles: boolean
}) {
  if (templates.length === 0 || !hasStyles) return null
  return (
    <div class="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
      <select id="bulk-apply-template-select" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">テンプレートを選択</option>
        {templates.map((t) => (
          <option value={t.id}>{t.template_name}</option>
        ))}
      </select>
      <button
        id="bulk-apply-btn"
        type="button"
        class="w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50"
      >
        <i class="fas fa-wand-magic-sparkles mr-2"></i>チェック中のスタイルに適用
      </button>
      <p class="text-xs text-gray-400">
        下のリストでチェックした（自動投稿対象の）スタイルに、選んだテンプレートの内容（画像・スタイル名・担当スタイリストを除く）を一括で反映します。
      </p>
    </div>
  )
}

style.get('/style/library', async (c) => {
  const user = c.get('user')

  const styles = await loadStyleListForUser(c, user)
  const totalCount = styles.length
  const selectedCount = styles.filter((s) => s.auto_post_enabled_flag === 1).length

  return c.render(
    <PageLayout active="style-library" salonName={user.salon_name} title="スタイル一覧">
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-2">
          <i class="fas fa-circle-info mr-2 text-pink-500"></i>使い方
        </p>
        <p class="text-sm text-gray-600 leading-relaxed">
          店舗全体のスタイルをここで一元管理します。新規作成したスタイルに「自動投稿対象」のチェックを入れると、
          自動投稿・手動投稿（<a href="/style/schedule" class="text-pink-600 hover:underline">設定はこちら</a>）で
          設定した時刻に、サロンボードへの登録＋反映申請まで自動で実行されます。
        </p>
      </div>

      <StyleListSection styles={styles} totalCount={totalCount} selectedCount={selectedCount} />

      <script src="/static/style-library.js"></script>
    </PageLayout>,
    { title: 'スタイル一覧' }
  )
})

// ---------- スタイル画像の配信 ----------

style.get('/style/image/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const owned = await c.env.DB.prepare(
    `SELECT si.r2_key FROM style_images si
     JOIN styles s ON s.id = si.style_id
     WHERE s.user_id = ? AND si.id = ?`
  )
    .bind(user.id, id)
    .first<{ r2_key: string }>()
  if (!owned) return c.notFound()

  const object = await c.env.STYLE_IMAGES.get(owned.r2_key)
  if (!object) return c.notFound()

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'private, max-age=86400'
    }
  })
})

// ---------- 既存スタイル取り込み(docs/phase3-mvp-design.md 5-2) ----------
// ⚠️ salonboard-import.tsの各関数は実HTML未確認のベストエフォート実装。
// 実ブラウザ(Puppeteer)経由のアクセスが必要なため、本番/リモート環境でのみ動作確認可能。

style.get('/style/import', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare('SELECT id FROM salon_credentials WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  return c.render(
    <PageLayout active="style-import" salonName={user.salon_name} title="既存スタイルの取り込み">
      {!cred && (
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
          <i class="fas fa-triangle-exclamation mr-2"></i>
          先に<a href="/settings/salonboard" class="underline font-semibold">サロンボード連携設定</a>を行ってください。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <button
          id="fetch-list-btn"
          disabled={!cred}
          class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:opacity-50"
        >
          <i class="fas fa-cloud-arrow-down mr-2"></i>サロンボードから一覧取得
        </button>
        <p id="import-status" class="text-sm text-gray-500 mt-3"></p>
      </div>

      <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
        <i class="fas fa-circle-info mr-2"></i>
        サロンボードに既に登録されているスタイルを一覧取得し、選択したものをSalonMotion側の
        スタイル一覧に取り込みます。取り込んだスタイルは「入力完了」扱いになりますが、
        自動投稿対象には初期状態では含まれません（重複投稿防止のため）。
      </div>

      <div id="import-list-container" class="bg-white rounded-xl border border-gray-100 p-6 hidden">
        <div class="flex items-center justify-between mb-3">
          <p class="font-semibold"><i class="fas fa-list-check mr-2 text-pink-500"></i>取り込むスタイルを選択</p>
          <button
            id="import-execute-btn"
            class="bg-pink-500 hover:bg-pink-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
          >
            選択したスタイルを取り込む
          </button>
        </div>
        <ul id="import-list" class="text-sm divide-y divide-gray-50"></ul>
      </div>

      <script src="/static/style-import.js"></script>
    </PageLayout>,
    { title: '既存スタイルの取り込み' }
  )
})

style.post('/api/style/import/fetch-list', async (c) => {
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

    browser = await launchBrowser()
    const page = await newAutomationPage(browser)
    await loginToSalonBoard(page, loginId, password, () => {}, c.env, user.id)

    const list = await fetchExistingStyles(page, () => {})
    return c.json({ success: true, styles: list })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

style.post('/api/style/import/execute', async (c) => {
  const user = c.get('user')
  const { styleIds } = await c.req.json<{ styleIds: string[] }>()

  if (!Array.isArray(styleIds) || styleIds.length === 0) {
    return c.json({ success: false, error: '取り込むスタイルを選択してください' }, 400)
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

    const result = await importSelectedStyles(page, c.env, user.id, styleIds, () => {})
    return c.json({ success: true, ...result })
  } catch (err: any) {
    return c.json({ success: false, error: String(err?.message || err) }, 400)
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
})

// ---------- スタイル作成/編集フォーム ----------

async function loadFormMasters(c: AppContext, user: AppUser) {
  const [stylists, coupons] = await Promise.all([
    c.env.DB.prepare('SELECT id, name FROM stylists WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare('SELECT id, name FROM coupons WHERE user_id = ? AND is_active = 1 ORDER BY sort_order ASC')
      .bind(user.id)
      .all<{ id: number; name: string }>()
  ])
  return { stylists: stylists.results || [], coupons: coupons.results || [] }
}

type TemplateForAutofill = {
  id: number
  template_name: string
  title_template: string | null
  comment_template: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  coupon_id: number | null
  hashtags_json: string
  model_attributes_json: string | null
}

async function loadActiveTemplates(c: AppContext, user: AppUser) {
  const { results } = await c.env.DB.prepare(
    `SELECT id, template_name, title_template, comment_template, category_value, length_value,
            menu_values_json, menu_detail_text, coupon_id, hashtags_json, model_attributes_json
     FROM templates WHERE user_id = ? AND active_flag = 1 ORDER BY id DESC`
  )
    .bind(user.id)
    .all<TemplateForAutofill>()
  return results || []
}

type StyleDetailRow = {
  id: number
  stylist_id: number | null
  coupon_id: number | null
  title: string | null
  comment: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  hashtags_json: string
  model_attributes_json: string | null
  auto_post_enabled_flag: number
  front_style_image_id: number | null
}

function StyleForm({
  mode,
  detail,
  stylists,
  coupons,
  templates
}: {
  mode: 'new' | 'edit'
  detail: StyleDetailRow | null
  stylists: { id: number; name: string }[]
  coupons: { id: number; name: string }[]
  templates: TemplateForAutofill[]
}) {
  const category = detail?.category_value || 'SG01'
  const menuCodes: string[] = detail ? JSON.parse(detail.menu_values_json || '[]') : []
  const hashtags: string[] = detail ? JSON.parse(detail.hashtags_json || '[]') : []
  const model: ModelAttributes = detail?.model_attributes_json ? JSON.parse(detail.model_attributes_json) : {}
  const action = mode === 'new' ? '/style/new' : `/style/${detail?.id}/edit`

  return (
    <form
      method="post"
      action={action}
      enctype="multipart/form-data"
      data-has-existing-image={detail?.front_style_image_id ? 'true' : 'false'}
      class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-2xl"
    >
      {mode === 'new' && templates.length > 0 && (
        <div class="bg-pink-50 border border-pink-100 rounded-lg p-3">
          <label class="block text-sm font-medium text-gray-700 mb-1">テンプレートから作成（任意）</label>
          <select id="template-select" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white">
            <option value="">テンプレートを選択せず入力する</option>
            {templates.map((t) => (
              <option value={t.id}>{t.template_name}</option>
            ))}
          </select>
          <p class="text-xs text-gray-500 mt-1">
            テンプレートを選ぶと、画像以外の項目が自動的に入力されます。画像だけ選んで登録してください。
          </p>
          <script
            id="template-data"
            type="application/json"
            dangerouslySetInnerHTML={{ __html: jsonForScriptTag(templates) }}
          ></script>
        </div>
      )}

      {/* 2026-08-09: 実際のサロンボードの入力順序(画像→スタイリスト→コメント→
          スタイル名→カテゴリ→長さ→メニュー内容→クーポン→ハッシュタグ→モデル情報)
          に合わせて並び替え済み(ユーザーが実画面のスクリーンショットで確認)。 */}
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          スタイル画像（FRONT）<span style="color:#d32475">*</span>
        </label>
        {detail?.front_style_image_id && (
          <img src={`/style/image/${detail.front_style_image_id}`} class="w-32 h-40 object-cover rounded-lg border border-gray-200 mb-2" />
        )}
        <input type="file" name="image" accept="image/*" class="block w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          担当スタイリスト<span style="color:#d32475">*</span>
        </label>
        <select name="stylist_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">未設定</option>
          {stylists.map((s) => (
            <option value={s.id} selected={detail?.stylist_id === s.id}>{s.name}</option>
          ))}
        </select>
        {stylists.length === 0 && (
          <p class="text-xs text-amber-600 mt-1">
            スタイリストが未登録です。<a href="/settings/salonboard" class="underline">連携設定</a>から同期してください。
          </p>
        )}
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          スタイリストコメント（最大120文字）<span style="color:#d32475">*</span>
        </label>
        <textarea
          name="comment"
          rows={4}
          maxlength={120}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.comment || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          スタイル名（最大30文字）<span style="color:#d32475">*</span>
        </label>
        <input
          type="text"
          name="title"
          maxlength={30}
          value={detail?.title || ''}
          required
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          カテゴリ<span style="color:#d32475">*</span>
        </label>
        <div class="flex gap-4 text-sm">
          <label class="flex items-center gap-1">
            <input type="radio" name="category_value" value="SG01" checked={category === 'SG01'} class="category-radio" />
            レディース
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" name="category_value" value="SG02" checked={category === 'SG02'} class="category-radio" />
            メンズ
          </label>
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">長さ</label>
        <select name="length_value_sg01" class="length-select w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-cat="SG01">
          <option value="">選択してください</option>
          {HAIR_LENGTH_OPTIONS.SG01.map(([v, label]) => (
            <option value={v} selected={detail?.length_value === v}>{label}</option>
          ))}
        </select>
        <select name="length_value_sg02" class="length-select w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mt-2" data-cat="SG02">
          <option value="">選択してください</option>
          {HAIR_LENGTH_OPTIONS.SG02.map(([v, label]) => (
            <option value={v} selected={detail?.length_value === v}>{label}</option>
          ))}
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          メニュー内容<span style="color:#d32475">*</span>
        </label>
        <div class="flex flex-wrap gap-3 text-sm mb-2">
          {MENU_OPTIONS.map(([v, label]) => (
            <label class="flex items-center gap-1">
              <input type="checkbox" name="menu_values" value={v} checked={menuCodes.includes(v)} />
              {label}
            </label>
          ))}
        </div>
        <textarea
          name="menu_detail_text"
          rows={2}
          maxlength={50}
          placeholder="メニュー内容（最大50文字）"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.menu_detail_text || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">クーポン（任意）</label>
        <select name="coupon_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">なし</option>
          {coupons.map((cp) => (
            <option value={cp.id} selected={detail?.coupon_id === cp.id}>{cp.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">ハッシュタグ（カンマ区切り）</label>
        <input
          type="text"
          name="hashtags"
          value={hashtags.join(',')}
          placeholder="奈良美容室,髪質改善,ブリーチ毛ケア"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <ModelAttributeFields model={model} />

      <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" name="auto_post_enabled" checked={detail ? detail.auto_post_enabled_flag === 1 : true} class="w-4 h-4 accent-pink-500" />
        自動投稿対象にする
      </label>

      <div class="flex gap-3">
        <button type="submit" class="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition">
          {mode === 'new' ? '作成する' : '更新する'}
        </button>
        {mode === 'edit' && (
          <a
            href={`/style/${detail?.id}/delete`}
            onclick="return confirm('このスタイルを削除しますか？')"
            class="px-5 py-2.5 rounded-lg border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50"
          >
            削除
          </a>
        )}
      </div>
      <script src="/static/style-form.js"></script>
    </form>
  )
}

style.get('/style/new', async (c) => {
  const user = c.get('user')
  const [{ stylists, coupons }, templates] = await Promise.all([
    loadFormMasters(c, user),
    loadActiveTemplates(c, user)
  ])
  return c.render(
    <PageLayout active="style-library" salonName={user.salon_name} title="スタイル新規作成">
      <StyleForm mode="new" detail={null} stylists={stylists} coupons={coupons} templates={templates} />
    </PageLayout>,
    { title: 'スタイル新規作成' }
  )
})

function parseStyleForm(body: Record<string, any>) {
  const category = String(body.category_value || 'SG01') as 'SG01' | 'SG02'
  const lengthValue =
    category === 'SG01' ? String(body.length_value_sg01 || '') : String(body.length_value_sg02 || '')
  const menuRaw = body.menu_values
  const menuValues: string[] = Array.isArray(menuRaw) ? menuRaw : menuRaw ? [menuRaw] : []
  const hashtags = String(body.hashtags || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    // 2026-08-09追記: 実際のサロンボードの文字数上限は30/50/120であり、
    // 旧来の60/100/240は誤りだった(HANDOFF.md参照)。
    title: String(body.title || '').trim().slice(0, 30),
    comment: String(body.comment || '').trim().slice(0, 120),
    categoryValue: category,
    lengthValue,
    menuValues,
    menuDetailText: String(body.menu_detail_text || '').trim().slice(0, 50),
    hashtags,
    modelAttributes: parseModelAttributesForm(body),
    stylistId: body.stylist_id ? Number(body.stylist_id) : null,
    couponId: body.coupon_id ? Number(body.coupon_id) : null,
    autoPostEnabled: body.auto_post_enabled === 'on' || body.auto_post_enabled === 'true'
  }
}

function computeInternalSaveStatus(parsed: ReturnType<typeof parseStyleForm>, hasImage: boolean): 'draft' | 'ready' {
  const requiredFilled =
    hasImage &&
    !!parsed.title &&
    !!parsed.comment &&
    !!parsed.lengthValue &&
    !!parsed.menuDetailText &&
    !!parsed.stylistId
  return requiredFilled ? 'ready' : 'draft'
}

async function saveImageIfProvided(c: AppContext, user: AppUser, styleId: number, body: Record<string, any>) {
  const file = body.image as File | undefined
  if (!file || !(file instanceof File) || file.size === 0) return

  const arrayBuffer = await file.arrayBuffer()
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const key = `style/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`

  await c.env.STYLE_IMAGES.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type || 'image/jpeg' }
  })

  const existingFront = await c.env.DB.prepare(
    `SELECT id, r2_key FROM style_images WHERE style_id = ? AND image_role = 'FRONT'`
  )
    .bind(styleId)
    .first<{ id: number; r2_key: string }>()

  if (existingFront) {
    await c.env.STYLE_IMAGES.delete(existingFront.r2_key).catch(() => {})
    await c.env.DB.prepare(`UPDATE style_images SET r2_key = ?, file_name = ? WHERE id = ?`)
      .bind(key, file.name, existingFront.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO style_images (style_id, image_role, r2_key, file_name, sort_order) VALUES (?, 'FRONT', ?, ?, 0)`
    )
      .bind(styleId, key, file.name)
      .run()
  }
}

style.post('/style/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const parsed = parseStyleForm(body)

  const hasImageUpload = body.image instanceof File && (body.image as File).size > 0
  const internalStatus = computeInternalSaveStatus(parsed, hasImageUpload)

  const insert = await c.env.DB.prepare(
    `INSERT INTO styles (
       user_id, stylist_id, coupon_id, source_type, title, comment, category_value, length_value,
       menu_values_json, menu_detail_text, hashtags_json, model_attributes_json, auto_post_enabled_flag, internal_save_status
     ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      parsed.stylistId,
      parsed.couponId,
      parsed.title,
      parsed.comment,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      JSON.stringify(parsed.hashtags),
      JSON.stringify(parsed.modelAttributes),
      parsed.autoPostEnabled ? 1 : 0,
      internalStatus
    )
    .run()

  const styleId = Number(insert.meta.last_row_id)
  await saveImageIfProvided(c, user, styleId, body)

  return c.redirect('/style/library?saved=1')
})

style.get('/style/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const detail = await c.env.DB.prepare(
    `SELECT s.id, s.stylist_id, s.coupon_id, s.title, s.comment, s.category_value, s.length_value,
            s.menu_values_json, s.menu_detail_text, s.hashtags_json, s.model_attributes_json, s.auto_post_enabled_flag,
            si.id AS front_style_image_id
     FROM styles s
     LEFT JOIN style_images si ON si.style_id = s.id AND si.image_role = 'FRONT'
     WHERE s.id = ? AND s.user_id = ?`
  )
    .bind(id, user.id)
    .first<StyleDetailRow>()

  if (!detail) return c.notFound()

  const { stylists, coupons } = await loadFormMasters(c, user)

  return c.render(
    <PageLayout active="style-library" salonName={user.salon_name} title="スタイル編集">
      <StyleForm mode="edit" detail={detail} stylists={stylists} coupons={coupons} templates={[]} />
    </PageLayout>,
    { title: 'スタイル編集' }
  )
})

style.post('/style/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const parsed = parseStyleForm(body)

  const owned = await c.env.DB.prepare('SELECT id FROM styles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number }>()
  if (!owned) return c.notFound()

  await saveImageIfProvided(c, user, id, body)

  const hasImage = await c.env.DB.prepare(
    `SELECT id FROM style_images WHERE style_id = ? AND image_role = 'FRONT'`
  )
    .bind(id)
    .first<{ id: number }>()

  const internalStatus = computeInternalSaveStatus(parsed, !!hasImage)

  await c.env.DB.prepare(
    `UPDATE styles SET
       stylist_id = ?, coupon_id = ?, title = ?, comment = ?, category_value = ?, length_value = ?,
       menu_values_json = ?, menu_detail_text = ?, hashtags_json = ?, model_attributes_json = ?,
       auto_post_enabled_flag = ?, internal_save_status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      parsed.stylistId,
      parsed.couponId,
      parsed.title,
      parsed.comment,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      JSON.stringify(parsed.hashtags),
      JSON.stringify(parsed.modelAttributes),
      parsed.autoPostEnabled ? 1 : 0,
      internalStatus,
      id,
      user.id
    )
    .run()

  return c.redirect('/style/library?saved=1')
})

style.get('/style/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const images = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE style_id = ?').bind(id).all<{ r2_key: string }>()
  for (const img of images.results || []) {
    await c.env.STYLE_IMAGES.delete(img.r2_key).catch(() => {})
  }

  await c.env.DB.prepare('DELETE FROM styles WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  return c.redirect('/style/library?deleted=1')
})

// ---------- Ajax: 自動投稿対象トグル・全選択/解除・削除 ----------

style.post('/api/style/toggle', async (c) => {
  const user = c.get('user')
  const { imageId, selected } = await c.req.json<{ imageId: number; selected: boolean }>()

  await c.env.DB.prepare('UPDATE styles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
    .bind(selected ? 1 : 0, imageId, user.id)
    .run()

  const row = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND auto_post_enabled_flag = 1')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
})

style.post('/api/style/bulk-select', async (c) => {
  const user = c.get('user')
  const { selected } = await c.req.json<{ selected: boolean }>()

  await c.env.DB.prepare('UPDATE styles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
    .bind(selected ? 1 : 0, user.id)
    .run()

  const row = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND auto_post_enabled_flag = 1')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
})

// テンプレート一括適用(docs/phase3-mvp-design.md 5-4)。
// 画像・担当スタイリストは変更せず、テンプレート項目(タイトルを除く)のみ反映する。
// タイトルは各スタイル固有のものとして扱い、一括適用では上書きしない。
const BULK_APPLY_MAX_STYLES = 100

style.post('/api/style/bulk-apply-template', async (c) => {
  const user = c.get('user')
  const { templateId, styleIds } = await c.req.json<{ templateId: number; styleIds: number[] }>()

  if (!templateId || !Array.isArray(styleIds) || styleIds.length === 0) {
    return c.json({ success: false, error: 'テンプレートと対象スタイルを選択してください' }, 400)
  }
  if (styleIds.length > BULK_APPLY_MAX_STYLES) {
    return c.json({ success: false, error: `一度に適用できるのは${BULK_APPLY_MAX_STYLES}件までです` }, 400)
  }

  const template = await c.env.DB.prepare(
    `SELECT id, comment_template, category_value, length_value, menu_values_json,
            menu_detail_text, coupon_id, hashtags_json, model_attributes_json
     FROM templates WHERE id = ? AND user_id = ?`
  )
    .bind(templateId, user.id)
    .first<TemplateForAutofill>()

  if (!template) return c.json({ success: false, error: 'テンプレートが見つかりません' }, 404)

  let appliedCount = 0
  const errors: string[] = []

  for (const styleId of styleIds) {
    try {
      const owned = await c.env.DB.prepare('SELECT id, title, stylist_id FROM styles WHERE id = ? AND user_id = ?')
        .bind(styleId, user.id)
        .first<{ id: number; title: string | null; stylist_id: number | null }>()
      if (!owned) {
        errors.push(`ID ${styleId}: 見つかりません`)
        continue
      }

      await c.env.DB.prepare(
        `UPDATE styles SET
           comment = ?, category_value = ?, length_value = ?, menu_values_json = ?,
           menu_detail_text = ?, coupon_id = ?, hashtags_json = ?, model_attributes_json = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ?`
      )
        .bind(
          template.comment_template,
          template.category_value,
          template.length_value,
          template.menu_values_json,
          template.menu_detail_text,
          template.coupon_id,
          template.hashtags_json,
          template.model_attributes_json,
          styleId,
          user.id
        )
        .run()

      const hasImage = await c.env.DB.prepare(
        `SELECT id FROM style_images WHERE style_id = ? AND image_role = 'FRONT'`
      )
        .bind(styleId)
        .first<{ id: number }>()

      const isReady =
        !!hasImage &&
        !!owned.title &&
        !!template.comment_template &&
        !!template.length_value &&
        !!template.menu_detail_text &&
        !!owned.stylist_id

      await c.env.DB.prepare('UPDATE styles SET internal_save_status = ? WHERE id = ?')
        .bind(isReady ? 'ready' : 'draft', styleId)
        .run()

      appliedCount++
    } catch (err: any) {
      errors.push(`ID ${styleId}: ${String(err?.message || err).slice(0, 200)}`)
    }
  }

  const resultStatus = errors.length === 0 ? 'success' : appliedCount > 0 ? 'partial' : 'failed'

  await c.env.DB.prepare(
    `INSERT INTO batch_template_apply_logs (user_id, template_id, applied_count, target_style_ids_json, result_status, error_message)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(user.id, templateId, appliedCount, JSON.stringify(styleIds), resultStatus, errors.length > 0 ? errors.join(' / ').slice(0, 1000) : null)
    .run()

  return c.json({ success: resultStatus !== 'failed', appliedCount, totalCount: styleIds.length, errors })
})

style.post('/style/library/delete/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const owned = await c.env.DB.prepare('SELECT id FROM styles WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ id: number }>()
  if (!owned) return c.json({ error: 'not found' }, 404)

  const images = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE style_id = ?').bind(id).all<{ r2_key: string }>()
  for (const img of images.results || []) {
    await c.env.STYLE_IMAGES.delete(img.r2_key).catch(() => {})
  }
  await c.env.DB.prepare('DELETE FROM styles WHERE id = ? AND user_id = ?').bind(id, user.id).run()

  return c.json({ success: true })
})

// ---------- 自動投稿・手動投稿 ----------

// 自動投稿の時間窓(JST)。src/lib/style-post-runner.tsのDAILY_WINDOW_START/END_MINUTESと一致させること。
const DAILY_WINDOW_START_LABEL = '7:00'
const DAILY_WINDOW_END_LABEL = '24:00'
// SalonMotion側の運用上の1日あたり自動投稿上限。src/lib/style-post-runner.tsのDAILY_POST_LIMITと一致させること。
const DAILY_POST_LIMIT_LABEL = 100

style.get('/style/schedule', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const schedule = await c.env.DB.prepare('SELECT enabled FROM style_post_schedules WHERE user_id = ?')
    .bind(user.id)
    .first<{ enabled: number }>()

  const enabled = schedule?.enabled === 1

  const selectedRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND auto_post_enabled_flag = 1 AND internal_save_status = 'ready'"
  )
    .bind(user.id)
    .first<{ cnt: number }>()
  const selectedCount = selectedRow?.cnt ?? 0

  return c.render(
    <PageLayout active="style-schedule" salonName={user.salon_name} title="自動投稿・手動投稿">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <p class="font-semibold text-gray-800">
        <i class="fas fa-clock mr-2 text-pink-500"></i>自動投稿
      </p>

      <form method="post" action="/style/schedule" class="bg-white rounded-xl border border-gray-100 p-6">
        <label class="flex items-center gap-3 cursor-pointer w-fit">
          <span class="relative inline-flex items-center flex-shrink-0">
            <input
              type="checkbox"
              name="enabled"
              checked={enabled}
              onchange="this.form.submit()"
              class="sr-only peer"
            />
            <span class="w-14 h-8 bg-gray-200 rounded-full peer-checked:bg-pink-500 transition-colors"></span>
            <span class="absolute left-1 top-1 w-6 h-6 bg-white rounded-full shadow transition-transform peer-checked:translate-x-6"></span>
          </span>
          <span class="text-sm font-medium text-gray-700">
            自動投稿を有効にする（{DAILY_WINDOW_START_LABEL}〜{DAILY_WINDOW_END_LABEL}に分散、最大{DAILY_POST_LIMIT_LABEL}件/日）
          </span>
        </label>
      </form>

      <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
        <i class="fas fa-circle-info mr-2"></i>
        自動投稿を有効にすると、<b>{DAILY_WINDOW_START_LABEL}〜{DAILY_WINDOW_END_LABEL}</b>の間に、自動投稿対象（入力完了済み）の
        スタイルを登録順に、時間帯全体へ均等に分散させながら「登録＋反映申請」まで自動実行します
        （1日最大<b>{DAILY_POST_LIMIT_LABEL}件</b>まで。短時間に集中投稿しないよう、対象件数に応じて投稿間隔を自動調整します）。
        現在<b>{selectedCount}件</b>が対象です。
      </div>

      <p class="font-semibold text-gray-800 pt-2">
        <i class="fas fa-flask mr-2 text-pink-500"></i>手動投稿
      </p>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <button
          id="test-run-btn"
          class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition disabled:opacity-50"
        >
          <i class="fas fa-flask mr-2"></i>手動実行する
        </button>
        <p id="test-run-status" class="text-sm text-gray-500 mt-3"></p>
      </div>

      <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
        <i class="fas fa-triangle-exclamation mr-2"></i>
        手動実行ボタンを押すと、現在自動投稿対象で入力完了済みのスタイルすべてに対して実際に
        サロンボードへの<b>登録＋反映申請（公開）</b>が実行されます。パスワードは画面・ログのどこにも表示されません。
        実行はAWS側のジョブとして非同期に行われるため、結果は完了次第、順次<a href="/style/test-run" class="underline font-semibold">実行履歴</a>に反映されます（数十秒〜数分かかります）。
      </div>

      <script src="/static/test-run.js"></script>
    </PageLayout>,
    { title: '自動投稿・手動投稿' }
  )
})

style.post('/style/schedule', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()

  const enabled = body.enabled === 'on' || body.enabled === 'true'

  const existing = await c.env.DB.prepare('SELECT id FROM style_post_schedules WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE style_post_schedules SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(enabled ? 1 : 0, user.id)
      .run()
  } else {
    await c.env.DB.prepare(`INSERT INTO style_post_schedules (user_id, enabled) VALUES (?, ?)`)
      .bind(user.id, enabled ? 1 : 0)
      .run()
  }

  return c.redirect('/style/schedule?saved=1')
})

// ---------- テンプレート管理 ----------
// docs/phase3-mvp-design.md 2-4。複数のテンプレートを作成し、
// スタイル一括作成・一括適用（今後実装）で使い回せるようにする。

type TemplateListRow = {
  id: number
  template_name: string
  title_template: string | null
  active_flag: number
}

style.get('/style/template', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const [{ results }, styles] = await Promise.all([
    c.env.DB.prepare(
      'SELECT id, template_name, title_template, active_flag FROM templates WHERE user_id = ? ORDER BY id DESC'
    )
      .bind(user.id)
      .all<TemplateListRow>(),
    loadStyleListForUser(c, user)
  ])

  const templates = results || []
  const totalCount = styles.length
  const selectedCount = styles.filter((s) => s.auto_post_enabled_flag === 1).length

  return c.render(
    <PageLayout active="style-template" salonName={user.salon_name} title="テンプレート作成・適用">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="flex items-center justify-between">
        <p class="font-semibold text-gray-800">
          <i class="fas fa-sliders mr-2 text-pink-500"></i>テンプレート作成（{templates.length}件）
        </p>
        <a href="/style/template/new" class="bg-pink-500 hover:bg-pink-600 text-white font-semibold text-sm px-4 py-2 rounded-lg">
          <i class="fas fa-plus mr-1"></i>新規作成
        </a>
      </div>

      {templates.length === 0 ? (
        <div class="bg-white rounded-xl border border-gray-100 p-6">
          <p class="text-sm text-gray-400 text-center py-6">まだテンプレートが登録されていません。</p>
        </div>
      ) : (
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          {templates.map((t) => (
            <div class="bg-white rounded-xl border border-gray-100 p-4 flex items-center justify-between gap-3">
              <div class="min-w-0">
                <a
                  href={`/style/template/${t.id}/edit`}
                  class="font-medium text-gray-700 hover:text-pink-600 truncate block"
                >
                  {t.template_name}
                </a>
                <p class="text-xs text-gray-400 truncate mt-0.5">
                  スタイル名: {t.title_template || '未設定'}
                </p>
                <span
                  class={
                    'inline-block mt-1 text-xs px-2 py-0.5 rounded font-semibold ' +
                    (t.active_flag === 1 ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400')
                  }
                >
                  {t.active_flag === 1 ? '有効' : '停止中'}
                </span>
              </div>
              <a
                href={`/style/template/${t.id}/edit`}
                class="flex-shrink-0 text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-3 py-1.5"
              >
                編集
              </a>
            </div>
          ))}
        </div>
      )}

      <p class="font-semibold text-gray-800 pt-2">
        <i class="fas fa-wand-magic-sparkles mr-2 text-pink-500"></i>テンプレート一括適用
      </p>

      <TemplateBulkApplySection templates={templates} hasStyles={styles.length > 0} />

      <StyleListSection styles={styles} totalCount={totalCount} selectedCount={selectedCount} showCreateLink={false} />

      <script src="/static/style-library.js"></script>
    </PageLayout>,
    { title: 'テンプレート作成・適用' }
  )
})

type TemplateDetailRow = {
  id: number
  template_name: string
  title_template: string | null
  comment_template: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  coupon_id: number | null
  hashtags_json: string
  model_attributes_json: string | null
  active_flag: number
}

function TemplateForm({
  mode,
  detail,
  coupons
}: {
  mode: 'new' | 'edit'
  detail: TemplateDetailRow | null
  coupons: { id: number; name: string }[]
}) {
  const category = detail?.category_value || 'SG01'
  const menuCodes: string[] = detail ? JSON.parse(detail.menu_values_json || '[]') : []
  const hashtags: string[] = detail ? JSON.parse(detail.hashtags_json || '[]') : []
  const model: ModelAttributes = detail?.model_attributes_json ? JSON.parse(detail.model_attributes_json) : {}
  const action = mode === 'new' ? '/style/template/new' : `/style/template/${detail?.id}/edit`

  return (
    <form method="post" action={action} class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-2xl">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          テンプレート名（管理用・投稿には使われません）<span style="color:#d32475">*</span>
        </label>
        <input
          type="text"
          name="template_name"
          required
          value={detail?.template_name || ''}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">コメント雛形（最大120文字）</label>
        <textarea
          name="comment_template"
          rows={4}
          maxlength={120}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.comment_template || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          スタイル名（最大30文字）<span style="color:#d32475">*</span>
        </label>
        <input
          type="text"
          name="title_template"
          maxlength={30}
          value={detail?.title_template || ''}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          カテゴリ<span style="color:#d32475">*</span>
        </label>
        <div class="flex gap-4 text-sm">
          <label class="flex items-center gap-1">
            <input type="radio" name="category_value" value="SG01" checked={category === 'SG01'} class="category-radio" />
            レディース
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" name="category_value" value="SG02" checked={category === 'SG02'} class="category-radio" />
            メンズ
          </label>
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">長さ</label>
        <select name="length_value_sg01" class="length-select w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" data-cat="SG01">
          <option value="">選択してください</option>
          {HAIR_LENGTH_OPTIONS.SG01.map(([v, label]) => (
            <option value={v} selected={detail?.length_value === v}>{label}</option>
          ))}
        </select>
        <select name="length_value_sg02" class="length-select w-full rounded-lg border border-gray-300 px-3 py-2 text-sm mt-2" data-cat="SG02">
          <option value="">選択してください</option>
          {HAIR_LENGTH_OPTIONS.SG02.map(([v, label]) => (
            <option value={v} selected={detail?.length_value === v}>{label}</option>
          ))}
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          メニュー内容<span style="color:#d32475">*</span>
        </label>
        <div class="flex flex-wrap gap-3 text-sm mb-2">
          {MENU_OPTIONS.map(([v, label]) => (
            <label class="flex items-center gap-1">
              <input type="checkbox" name="menu_values" value={v} checked={menuCodes.includes(v)} />
              {label}
            </label>
          ))}
        </div>
        <textarea
          name="menu_detail_text"
          rows={2}
          maxlength={50}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.menu_detail_text || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">クーポン（任意）</label>
        <select name="coupon_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">なし</option>
          {coupons.map((cp) => (
            <option value={cp.id} selected={detail?.coupon_id === cp.id}>{cp.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">ハッシュタグ（カンマ区切り）</label>
        <input
          type="text"
          name="hashtags"
          value={hashtags.join(',')}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <ModelAttributeFields model={model} />

      <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
        <input type="checkbox" name="active" checked={detail ? detail.active_flag === 1 : true} class="w-4 h-4 accent-pink-500" />
        有効にする
      </label>

      <div class="flex gap-3">
        <button type="submit" class="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition">
          {mode === 'new' ? '作成する' : '更新する'}
        </button>
        {mode === 'edit' && (
          <a
            href={`/style/template/${detail?.id}/delete`}
            onclick="return confirm('このテンプレートを削除しますか？')"
            class="px-5 py-2.5 rounded-lg border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50"
          >
            削除
          </a>
        )}
      </div>
      <script src="/static/style-form.js"></script>
    </form>
  )
}

function parseTemplateForm(body: Record<string, any>) {
  const category = String(body.category_value || 'SG01') as 'SG01' | 'SG02'
  const lengthValue =
    category === 'SG01' ? String(body.length_value_sg01 || '') : String(body.length_value_sg02 || '')
  const menuRaw = body.menu_values
  const menuValues: string[] = Array.isArray(menuRaw) ? menuRaw : menuRaw ? [menuRaw] : []
  const hashtags = String(body.hashtags || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    templateName: String(body.template_name || '').trim(),
    titleTemplate: String(body.title_template || '').trim().slice(0, 30),
    commentTemplate: String(body.comment_template || '').trim().slice(0, 120),
    categoryValue: category,
    lengthValue,
    menuValues,
    menuDetailText: String(body.menu_detail_text || '').trim().slice(0, 50),
    hashtags,
    modelAttributes: parseModelAttributesForm(body),
    couponId: body.coupon_id ? Number(body.coupon_id) : null,
    active: body.active === 'on' || body.active === 'true'
  }
}

style.get('/style/template/new', async (c) => {
  const user = c.get('user')
  const { coupons } = await loadFormMasters(c, user)
  return c.render(
    <PageLayout active="style-template" salonName={user.salon_name} title="テンプレート新規作成">
      <TemplateForm mode="new" detail={null} coupons={coupons} />
    </PageLayout>,
    { title: 'テンプレート新規作成' }
  )
})

style.post('/style/template/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const parsed = parseTemplateForm(body)

  if (!parsed.templateName) {
    return c.redirect('/style/template/new?error=' + encodeURIComponent('テンプレート名は必須です'))
  }

  await c.env.DB.prepare(
    `INSERT INTO templates (
       user_id, template_name, title_template, comment_template, category_value, length_value,
       menu_values_json, menu_detail_text, coupon_id, hashtags_json, model_attributes_json, active_flag
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      parsed.templateName,
      parsed.titleTemplate,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.couponId,
      JSON.stringify(parsed.hashtags),
      JSON.stringify(parsed.modelAttributes),
      parsed.active ? 1 : 0
    )
    .run()

  return c.redirect('/style/template?saved=1')
})

style.get('/style/template/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const detail = await c.env.DB.prepare(
    `SELECT id, template_name, title_template, comment_template, category_value, length_value, menu_values_json,
            menu_detail_text, coupon_id, hashtags_json, model_attributes_json, active_flag
     FROM templates WHERE id = ? AND user_id = ?`
  )
    .bind(id, user.id)
    .first<TemplateDetailRow>()

  if (!detail) return c.notFound()

  const { coupons } = await loadFormMasters(c, user)

  return c.render(
    <PageLayout active="style-template" salonName={user.salon_name} title="テンプレート編集">
      <TemplateForm mode="edit" detail={detail} coupons={coupons} />
    </PageLayout>,
    { title: 'テンプレート編集' }
  )
})

style.post('/style/template/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const parsed = parseTemplateForm(body)

  if (!parsed.templateName) {
    return c.redirect(`/style/template/${id}/edit?error=` + encodeURIComponent('テンプレート名は必須です'))
  }

  await c.env.DB.prepare(
    `UPDATE templates SET
       template_name = ?, title_template = ?, comment_template = ?, category_value = ?, length_value = ?,
       menu_values_json = ?, menu_detail_text = ?, coupon_id = ?, hashtags_json = ?, model_attributes_json = ?,
       active_flag = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      parsed.templateName,
      parsed.titleTemplate,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.couponId,
      JSON.stringify(parsed.hashtags),
      JSON.stringify(parsed.modelAttributes),
      parsed.active ? 1 : 0,
      id,
      user.id
    )
    .run()

  return c.redirect('/style/template?saved=1')
})

style.get('/style/template/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').bind(id, user.id).run()
  return c.redirect('/style/template?deleted=1')
})

export default style
