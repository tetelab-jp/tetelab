import { Hono, type Context } from 'hono'
import { requireAuth, requireStyleEnabled } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import { decryptSecret } from '../lib/crypto'
import { launchBrowser, newAutomationPage, loginToSalonBoard, handleGroupTopIfPresent } from '../lib/salonboard-automation'
import { fetchExistingStyles, importSelectedStyles } from '../lib/salonboard-import'
import { fetchSalonInfoFromSalonBoard } from '../lib/salonboard-sync'
import { processStyleImage } from '../lib/image-process'
import { INITIAL_BURST_COUNT, resetStuckJobsForUser } from '../lib/style-post-runner'
import type { Bindings, AppUser } from '../types'

type AppContext = Context<{ Bindings: Bindings; Variables: { user: AppUser } }>

const style = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

// 2026-08-12追記(重大バグ修正): '*'で登録すると、index.tsxで全サブアプリが
// 同じベースパス('/')にapp.route()マウントされている都合上、このサブアプリに
// 存在しないパス(例: /admin/*)に対してもこのミドルウェアが先に反応し、
// 未ログイン/機能OFF等の理由でリダイレクトを返してしまい、後続でマウントされる
// 他のサブアプリ(blog、admin等)へのリクエストを乗っ取ってしまう(実機で確認
// 済みの不具合)。自分が実際に持つルートのパスパターンだけを明示することで防ぐ。
style.use('/style/*', requireAuth)
style.use('/api/style/*', requireAuth)
style.use('/style/*', requireStyleEnabled)
style.use('/api/style/*', requireStyleEnabled)

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

function AutoPostStatusBadges({ s }: { s: StyleListRow }) {
  const isOn = s.auto_post_enabled_flag === 1
  return (
    <>
      <span
        class={
          'auto-post-badge text-xs px-2 py-0.5 rounded font-semibold ' +
          (isOn ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-400')
        }
      >
        自動投稿{isOn ? 'ON' : 'OFF'}
      </span>
      {s.reflection_request_status === 'success' && (
        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-green-50 text-green-600">公開</span>
      )}
      {(s.reflection_request_status === 'failed' || s.reflection_request_status === 'blocked') && (
        <span class="text-xs px-2 py-0.5 rounded font-semibold bg-red-50 text-red-600">エラー</span>
      )}
    </>
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
     WHERE s.user_id = ? AND s.salon_id = ?
     ORDER BY s.sort_order ASC, s.id DESC`
  )
    .bind(user.id, user.active_salon_id)
    .all<StyleListRow>()
  return results || []
}

// 2026-08-12追記: 新規スタイル作成時にsort_orderを指定しないと0のまま
// 挿入され、既存スタイル(手動並び替え後は0,1,2...の連番)の先頭グループと
// 同点になり、id DESCの同点判定で先頭付近に割り込んでしまう(「最後尾に
// 追加されるべきものが先頭に来る」不具合)。新規作成時は必ずこの関数で
// 現在の最大sort_order+1を採番し、リストの最後尾に追加されるようにする。
async function getNextSortOrder(c: AppContext, userId: number, salonId: number | null): Promise<number> {
  const row = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM styles WHERE user_id = ? AND salon_id = ?'
  )
    .bind(userId, salonId)
    .first<{ next_order: number }>()
  return row?.next_order ?? 0
}

function StyleListSection({
  styles,
  totalCount,
  selectedCount,
  showCreateLink = true,
  heading = '登録済みスタイル',
  checkboxMode = 'auto-post'
}: {
  styles: StyleListRow[]
  totalCount: number
  selectedCount: number
  showCreateLink?: boolean
  heading?: string
  // 'auto-post': 自動投稿対象(auto_post_enabled_flag、DBへ即時保存)の選択。
  // 'template-target': テンプレート一括適用の対象選択のみの、ページ内限定の一時的な
  // チェック(DBには保存しない、常に未選択から始まる、登録スタイル側の状態に影響しない)。
  checkboxMode?: 'auto-post' | 'template-target'
}) {
  const isTemplateMode = checkboxMode === 'template-target'
  return (
    <>
      <div class="flex items-center justify-between flex-wrap gap-2">
        <p class="font-semibold flex items-center gap-2 flex-wrap">
          <span><i class="fas fa-portrait mr-2 text-pink-500"></i>{heading}（{totalCount}件）</span>
          <span class="text-sm font-normal text-gray-600">
            {isTemplateMode ? '選択中' : '投稿対象'}:{' '}
            <span id={isTemplateMode ? 'template-target-selected-count' : 'selected-count'} class="font-bold text-pink-600">
              {isTemplateMode ? 0 : selectedCount}
            </span>{' '}
            / {totalCount} 件
          </span>
        </p>
        <div class="flex items-center flex-nowrap gap-2">
          {isTemplateMode && (
            <>
              <button
                id="template-target-select-all-btn"
                type="button"
                class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-2 py-1 whitespace-nowrap"
              >
                このページを全選択
              </button>
              <button
                id="template-target-deselect-all-btn"
                type="button"
                class="text-xs font-semibold text-gray-500 hover:text-pink-600 border border-gray-300 rounded px-2 py-1 whitespace-nowrap"
              >
                このページを全解除
              </button>
            </>
          )}
          {!isTemplateMode && (
            <select id="style-filter-select" class="text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg px-3 py-2">
              <option value="all">すべて</option>
              <option value="on">ONのみ</option>
              <option value="off">OFFのみ</option>
            </select>
          )}
          {showCreateLink && (
            <a
              href="/style/new"
              class="bg-pink-500 hover:bg-pink-600 text-white text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap flex-shrink-0"
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
            {!isTemplateMode && (
              <div class="flex items-center gap-2 mb-3">
                <button
                  type="button"
                  id="style-select-all-btn"
                  class="bg-pink-50 hover:bg-pink-100 border border-pink-300 text-pink-600 text-sm font-semibold px-4 py-2 rounded-lg"
                >
                  <i class="fas fa-check-double mr-1.5"></i>全選択
                </button>
                <button
                  type="button"
                  id="style-deselect-all-btn"
                  class="bg-gray-50 hover:bg-gray-100 border border-gray-300 text-gray-600 text-sm font-semibold px-4 py-2 rounded-lg"
                >
                  <i class="fas fa-xmark mr-1.5"></i>全解除
                </button>
              </div>
            )}
            <div class="hidden md:flex items-center gap-4 pb-2 border-b border-gray-100 text-xs font-semibold text-gray-400">
              <span class="w-10 flex-shrink-0 text-center">No</span>
              <span class="w-5 flex-shrink-0"></span>
              <span class="w-20 flex-shrink-0">画像</span>
              <span class="flex-1 min-w-0">スタイル名 / スタイリスト</span>
              <span class="flex-shrink-0">操作</span>
            </div>
            <div id="style-list" class="divide-y divide-gray-100">
            {styles.map((s, idx) => (
              <div
                class="flex items-center gap-2 md:gap-4 py-1.5 md:py-3"
                data-image-id={s.id}
                data-auto-post={s.auto_post_enabled_flag === 1 ? '1' : '0'}
              >
                <div class="flex flex-col items-center gap-1 flex-shrink-0 md:flex-row md:gap-4">
                  <input
                    type="number"
                    min="1"
                    value={idx + 1}
                    class="style-order-input w-6 h-6 flex-shrink-0 text-center text-xs text-gray-600 border border-gray-300 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    data-image-id={s.id}
                  />
                  <input
                    type="checkbox"
                    class={
                      (isTemplateMode ? 'template-target-checkbox' : 'style-checkbox') +
                      ' w-6 h-6 accent-pink-500 cursor-pointer flex-shrink-0'
                    }
                    checked={!isTemplateMode && s.auto_post_enabled_flag === 1}
                    data-image-id={s.id}
                  />
                </div>
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
                  <a href={`/style/${s.id}/edit`} class="block truncate text-sm md:text-base font-medium text-gray-700 hover:text-pink-600">
                    {s.title || '（無題）'}
                  </a>
                  <p class="text-xs text-gray-400 mt-0.5">{s.stylist_name || '担当未設定'}</p>
                  <div class="flex flex-wrap gap-1 mt-1">
                    <AutoPostStatusBadges s={s} />
                  </div>
                </div>
                <div class="flex flex-col md:flex-row items-stretch md:items-center gap-1 md:gap-2 flex-shrink-0">
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
        下のリストでチェックしたスタイルに、選んだテンプレートの内容（画像・スタイル名を除く）を一括で反映します。
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
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-library"
      salonName={user.salon_name}
      title="スタイル一覧"
      blogEnabled={user.blog_enabled !== 0}
    >
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-2">
          <i class="fas fa-circle-info mr-2 text-pink-500"></i>使い方
        </p>
        <p class="text-sm text-gray-600 leading-relaxed">
          自動更新するスタイルを管理します。
          チェックを入れると「自動投稿対象」になり、サロンボードへの登録＋反映申請まで実行されます。
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
     WHERE s.user_id = ? AND s.salon_id = ? AND si.id = ?`
  )
    .bind(user.id, user.active_salon_id, id)
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
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-import"
      salonName={user.salon_name}
      title="既存スタイルの取り込み"
      blogEnabled={user.blog_enabled !== 0}
    >
      {!cred && (
        <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
          <i class="fas fa-triangle-exclamation mr-2"></i>
          先に<a href="/settings/salonboard" class="underline font-semibold">サロンボード連携設定</a>を行ってください。
        </div>
      )}

      <div class="bg-white rounded-xl border border-gray-100 p-6 flex flex-col items-center md:items-start">
        <button
          id="fetch-list-btn"
          disabled={!cred}
          class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed"
        >
          <i class="fas fa-cloud-arrow-down mr-2"></i>
          <span id="fetch-list-btn-label">サロンボードからスタイル取得</span>
        </button>
        <p id="import-status" class="text-sm text-gray-500 mt-3 whitespace-pre-line"></p>
      </div>

      <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
        <i class="fas fa-circle-info mr-2"></i>
        サロンボードに既に登録されているスタイルを一覧取得し、選択したものをSalonMotion側の
        スタイル一覧に取り込みます。取り込んだスタイルは「入力完了」扱いになりますが、
        自動投稿対象には初期状態では含まれません（重複投稿防止のため）。
      </div>

      <div id="import-list-container" data-cache-scope={`${user.id}_${user.active_salon_id ?? ''}`} class="bg-white rounded-xl border border-gray-100 p-6 hidden">
        <div class="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
          <p class="font-semibold sm:flex-1">
            <i class="fas fa-list-check mr-2 text-pink-500"></i>取り込むスタイルを選択
          </p>
          <button
            id="import-execute-btn"
            class="w-full sm:w-auto flex-shrink-0 bg-pink-500 hover:bg-pink-600 text-white font-semibold text-sm sm:text-base px-6 py-3.5 sm:px-8 sm:py-3.5 rounded-lg disabled:opacity-50"
          >
            <span id="import-execute-btn-label">登録スタイルへ追加</span>
          </button>
        </div>
        <div class="flex items-center gap-2 mb-3">
          <button
            type="button"
            id="import-select-all-btn"
            class="bg-pink-50 hover:bg-pink-100 border border-pink-300 text-pink-600 text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <i class="fas fa-check-double mr-1.5"></i>このページを全選択
          </button>
          <button
            type="button"
            id="import-deselect-all-btn"
            class="bg-gray-50 hover:bg-gray-100 border border-gray-300 text-gray-600 text-sm font-semibold px-4 py-2 rounded-lg"
          >
            <i class="fas fa-xmark mr-1.5"></i>このページを全解除
          </button>
        </div>
        <p id="import-execute-status" class="text-xs text-gray-500 mb-3 min-h-[1rem]"></p>
        <ul id="import-list" class="text-sm divide-y divide-gray-50"></ul>
        <div id="import-pagination" class="hidden items-center justify-between text-sm text-gray-500 mt-3 pt-3 border-t border-gray-100">
          <span id="import-pagination-label"></span>
          <div class="flex gap-3">
            <button type="button" id="import-page-prev" class="hover:text-pink-600 disabled:opacity-30 disabled:cursor-not-allowed" disabled>
              ← 前へ
            </button>
            <button type="button" id="import-page-next" class="hover:text-pink-600 disabled:opacity-30 disabled:cursor-not-allowed" disabled>
              次へ →
            </button>
          </div>
        </div>
      </div>

      <div id="import-progress-modal" class="hidden fixed inset-0 z-50 items-center justify-center bg-black/50 p-4">
        <div class="bg-white rounded-xl p-6 max-w-sm w-full text-center space-y-3">
          <i class="fas fa-circle-notch fa-spin text-3xl text-pink-500"></i>
          <p id="import-progress-text" class="font-semibold">取り込み中...</p>
          <p class="text-xs text-gray-400">この画面を閉じずにそのままお待ちください</p>
          <button
            type="button"
            id="import-abort-btn"
            class="text-sm text-gray-500 hover:text-red-500 underline"
          >
            中止する
          </button>
        </div>
      </div>

      <script src="/static/style-import.js"></script>
    </PageLayout>,
    { title: '既存スタイルの取り込み' }
  )
})

/**
 * 複数サロンアカウント対応: ログイン直後に「サロン一覧」中間ページが出た場合、
 * salon_credentials.target_store_idで対象を確定させる。未選択の場合は
 * 設定画面でサロンを選び直すよう案内するエラーを投げる(ここでは新規に
 * 選択フローを開始しない。選択は/api/settings/sync-stylists-couponsで行う)。
 */
async function ensureSalonSelected(
  page: any,
  targetStoreId: string | null | undefined,
  log: (msg: string) => void
): Promise<void> {
  const result = await handleGroupTopIfPresent(page, targetStoreId, log)
  if (result.status === 'needs_selection' || result.status === 'target_not_found') {
    throw new Error(
      'このアカウントには複数のサロンが登録されています。設定画面の「サロンボードと同期する」で使用するサロンを選択してください'
    )
  }
}

// 2026-08-17追記(至急・ユーザー報告対応): 「既存スタイル取り込み」で
// 全く無関係な他サロンのスタイルがプレビューに表示される不具合が報告された。
// このプレビューはSalonMotionのDBを一切経由せず、ログイン済みのブラウザ
// セッションから直接スクレイピングしているため、原因はDBクエリではなく
// ログイン後のセッション/プロキシ側にある可能性が高いが、実環境での
// 再現・特定には至っていない。根本原因の特定に関わらず、誤ったサロンの
// データを絶対に取り込ませない安全策として、スクレイピング直前に
// ログイン後の画面が表示しているサロン名・サロンID(STORE_ID)を、
// このユーザーが登録しているサロン情報(salonboard_salons.salon_key)と
// 突き合わせ、一致しない場合は取り込みを中断する。
// 期待値(salon_key)が未登録のサロン(初回同期がまだの場合など)では
// 突き合わせできないため、警告ログのみでスキップする(誤ブロックを避ける)。
async function verifyLoggedInSalonMatches(
  c: AppContext,
  page: any,
  user: AppUser,
  log: (msg: string) => void
): Promise<void> {
  const expected = await c.env.DB.prepare('SELECT salon_key, salon_name FROM salonboard_salons WHERE id = ?')
    .bind(user.active_salon_id)
    .first<{ salon_key: string | null; salon_name: string | null }>()

  if (!expected?.salon_key) {
    console.warn(
      `[style-import] サロン照合スキップ(登録済みsalon_key無し): user_id=${user.id} salon_id=${user.active_salon_id}`
    )
    return
  }

  const actual = await fetchSalonInfoFromSalonBoard(page)
  if (!actual?.storeId || actual.storeId !== expected.salon_key) {
    console.error(
      `[style-import] サロン不一致を検出したため取り込みを中断: user_id=${user.id} salon_id=${user.active_salon_id} ` +
        `expected_salon_key=${expected.salon_key} actual_store_id=${actual?.storeId || '(取得不可)'} ` +
        `actual_salon_name=${actual?.salonName || '(取得不可)'}`
    )
    log('警告: ログイン後の画面が登録済みのサロンと一致しないため、安全のため取り込みを中断しました')
    throw new Error(
      'サロンボードへのログイン結果が登録済みのサロンと一致しなかったため、安全のため取り込みを中断しました。時間を置いて再度お試しいただくか、解決しない場合は運営までお問い合わせください。'
    )
  }
}

style.post('/api/style/import/fetch-list', async (c) => {
  const user = c.get('user')
  const cred = await c.env.DB.prepare(
    'SELECT salonboard_login_id_enc, salonboard_password_enc, target_store_id FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string; target_store_id: string | null }>()

  if (!cred) return c.json({ success: false, error: 'サロンボードのログイン情報が未登録です' }, 400)
  if (!c.env.ENCRYPTION_KEY) return c.json({ success: false, error: 'ENCRYPTION_KEYが未設定です' }, 500)

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
    const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

    browser = await launchBrowser()
    const page = await newAutomationPage(browser)
    await loginToSalonBoard(page, loginId, password, () => {}, c.env, user.id)
    await ensureSalonSelected(page, cred.target_store_id, () => {})
    await verifyLoggedInSalonMatches(c, page, user, () => {})

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
    'SELECT salonboard_login_id_enc, salonboard_password_enc, target_store_id FROM salon_credentials WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ salonboard_login_id_enc: string; salonboard_password_enc: string; target_store_id: string | null }>()

  if (!cred) return c.json({ success: false, error: 'サロンボードのログイン情報が未登録です' }, 400)
  if (!c.env.ENCRYPTION_KEY) return c.json({ success: false, error: 'ENCRYPTION_KEYが未設定です' }, 500)

  let browser: Awaited<ReturnType<typeof launchBrowser>> | null = null
  try {
    const loginId = await decryptSecret(cred.salonboard_login_id_enc, c.env.ENCRYPTION_KEY)
    const password = await decryptSecret(cred.salonboard_password_enc, c.env.ENCRYPTION_KEY)

    browser = await launchBrowser()
    const page = await newAutomationPage(browser)
    await loginToSalonBoard(page, loginId, password, () => {}, c.env, user.id)
    await ensureSalonSelected(page, cred.target_store_id, () => {})
    await verifyLoggedInSalonMatches(c, page, user, () => {})

    if (!user.active_salon_id) return c.json({ success: false, error: '対象のサロンが選択されていません' }, 400)
    const result = await importSelectedStyles(page, c.env, user.id, user.active_salon_id, styleIds, () => {}, c.req.raw.signal)
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
    c.env.DB.prepare(
      'SELECT id, name FROM stylists WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC'
    )
      .bind(user.id, user.active_salon_id)
      .all<{ id: number; name: string }>(),
    c.env.DB.prepare(
      'SELECT id, name FROM coupons WHERE user_id = ? AND salon_id = ? AND is_active = 1 ORDER BY sort_order ASC'
    )
      .bind(user.id, user.active_salon_id)
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
  stylist_id: number | null
  coupon_id: number | null
  hashtags_json: string
  model_attributes_json: string | null
}

async function loadActiveTemplates(c: AppContext, user: AppUser) {
  const { results } = await c.env.DB.prepare(
    `SELECT id, template_name, title_template, comment_template, category_value, length_value,
            menu_values_json, menu_detail_text, stylist_id, coupon_id, hashtags_json, model_attributes_json
     FROM templates WHERE user_id = ? AND salon_id = ? AND active_flag = 1 ORDER BY id DESC`
  )
    .bind(user.id, user.active_salon_id)
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
  templates,
  imageError
}: {
  mode: 'new' | 'edit'
  detail: StyleDetailRow | null
  stylists: { id: number; name: string }[]
  coupons: { id: number; name: string }[]
  templates: TemplateForAutofill[]
  imageError?: boolean
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
      {imageError && (
        <div class="rounded-lg bg-red-50 border border-red-200 text-red-700 px-4 py-3 text-sm">
          <i class="fas fa-circle-exclamation mr-2"></i>
          画像の処理に失敗しました。別の画像でもう一度お試しください。
        </div>
      )}
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
        <label
          for="style-image-input"
          id="style-image-dropzone"
          class="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-xl px-4 py-10 text-center cursor-pointer hover:border-pink-400 hover:bg-pink-50 transition-colors"
        >
          <i class="fas fa-cloud-arrow-up text-3xl text-gray-300"></i>
          <span id="style-image-dropzone-label" class="text-sm font-semibold text-gray-600">タップして画像を選択</span>
          <span class="text-xs text-gray-400">{detail?.front_style_image_id ? '変更する場合のみ選択してください' : 'このスタイルの画像として登録します'}</span>
        </label>
        <input type="file" id="style-image-input" name="image" accept="image/*" class="hidden" />
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
        <label class="block text-sm font-medium text-gray-700 mb-1">
          長さ<span style="color:#d32475">*</span>
        </label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">メニュー内容（該当するものを選択、任意）</label>
        <div class="flex flex-wrap gap-3 text-sm mb-2">
          {MENU_OPTIONS.map(([v, label]) => (
            <label class="flex items-center gap-1">
              <input type="checkbox" name="menu_values" value={v} checked={menuCodes.includes(v)} />
              {label}
            </label>
          ))}
        </div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          メニュー内容（テキスト）<span style="color:#d32475">*</span>
        </label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">ハッシュタグ（スラッシュ区切り）</label>
        <input
          type="text"
          name="hashtags"
          value={hashtags.join('/')}
          placeholder="奈良美容室/髪質改善/ブリーチ毛ケア"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <p class="hashtags-error hidden text-xs text-red-500 mt-1">
          各タグは文字・数字のみ使用できます(空白・記号は使用できません)。
        </p>
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
          <button
            type="submit"
            formaction={`/style/${detail?.id}/delete`}
            formmethod="post"
            onclick="return confirm('このスタイルを削除しますか？')"
            class="px-5 py-2.5 rounded-lg border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50"
          >
            削除
          </button>
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
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-library"
      salonName={user.salon_name}
      title="スタイル新規作成"
      blogEnabled={user.blog_enabled !== 0}
    >
      <StyleForm mode="new" detail={null} stylists={stylists} coupons={coupons} templates={templates} />
    </PageLayout>,
    { title: 'スタイル新規作成' }
  )
})

// public/static/style-form.jsのHASHTAGS_ALLOWED_PATTERNと同じ許可文字
// (英数字・記号無し)。JSを経由しない直接POSTでも同じ制約を強制するため、
// サーバー側でも同じパターンでフィルタする(部分一致ではなく1タグ丸ごと)。
const HASHTAG_ALLOWED_PATTERN = /^[\p{L}\p{N}]+$/u

function parseStyleForm(body: Record<string, any>) {
  const category = String(body.category_value || 'SG01') as 'SG01' | 'SG02'
  const lengthValue =
    category === 'SG01' ? String(body.length_value_sg01 || '') : String(body.length_value_sg02 || '')
  const menuRaw = body.menu_values
  const menuValues: string[] = Array.isArray(menuRaw) ? menuRaw : menuRaw ? [menuRaw] : []
  const hashtags = String(body.hashtags || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => HASHTAG_ALLOWED_PATTERN.test(s))

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
  // プロキシ経由のアップロードが大きいPOSTボディで失敗しやすいため、保存前に
  // 縦4:横3・最大600x800px・300KB以下のJPEGへ正規化する(image-process.ts参照)。
  // 出力は常にJPEGになるため拡張子もjpgで統一する。
  const { buffer, contentType } = await processStyleImage(arrayBuffer)
  const key = `style/${user.id}/${Date.now()}-${crypto.randomUUID()}.jpg`
  // 元ファイル名の拡張子(.png/.heic等)をそのまま保存すると、実際の中身は
  // JPEGなのにファイル名だけ拡張子が食い違ったまま自動投稿時のアップロード
  // ファイル名に使われてしまう。出力は常にJPEGなので拡張子もjpgへ統一する。
  const fileName = `${(file.name || 'style').replace(/\.[^./\\]+$/, '')}.jpg`

  await c.env.STYLE_IMAGES.put(key, buffer, {
    httpMetadata: { contentType }
  })

  const existingFront = await c.env.DB.prepare(
    `SELECT id, r2_key FROM style_images WHERE style_id = ? AND image_role = 'FRONT'`
  )
    .bind(styleId)
    .first<{ id: number; r2_key: string }>()

  if (existingFront) {
    await c.env.STYLE_IMAGES.delete(existingFront.r2_key).catch(() => {})
    await c.env.DB.prepare(
      `UPDATE style_images SET r2_key = ?, file_name = ?, compressed_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(key, fileName, existingFront.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO style_images (style_id, image_role, r2_key, file_name, sort_order, compressed_at)
       VALUES (?, 'FRONT', ?, ?, 0, CURRENT_TIMESTAMP)`
    )
      .bind(styleId, key, fileName)
      .run()
  }
}

style.post('/style/new', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()
  const parsed = parseStyleForm(body)

  const hasImageUpload = body.image instanceof File && (body.image as File).size > 0
  const internalStatus = computeInternalSaveStatus(parsed, hasImageUpload)
  const nextSortOrder = await getNextSortOrder(c, user.id, user.active_salon_id)

  const insert = await c.env.DB.prepare(
    `INSERT INTO styles (
       user_id, salon_id, stylist_id, coupon_id, source_type, title, comment, category_value, length_value,
       menu_values_json, menu_detail_text, hashtags_json, model_attributes_json, auto_post_enabled_flag, internal_save_status,
       sort_order
     ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      user.active_salon_id,
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
      nextSortOrder
    )
    .run()

  const styleId = Number(insert.meta.last_row_id)
  try {
    await saveImageIfProvided(c, user, styleId, body)
  } catch (err: any) {
    // 2026-08-13追記(重大バグ修正): 画像処理(sharp)が不正なファイル等で
    // 例外を投げると、スタイル行は既にINSERT済みのまま素の500エラーで
    // 終わっていた(内部ステータスがreadyのまま画像無しの中途半端な
    // レコードが残る恐れもあった)。ステータスをdraftへ差し戻し、
    // ユーザーへ編集画面でエラーを伝える。
    await c.env.DB.prepare(`UPDATE styles SET internal_save_status = 'draft' WHERE id = ?`).bind(styleId).run().catch(() => {})
    return c.redirect(`/style/${styleId}/edit?imageError=1`)
  }

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
     WHERE s.id = ? AND s.user_id = ? AND s.salon_id = ?`
  )
    .bind(id, user.id, user.active_salon_id)
    .first<StyleDetailRow>()

  if (!detail) return c.notFound()

  const { stylists, coupons } = await loadFormMasters(c, user)

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-library"
      salonName={user.salon_name}
      title="スタイル編集"
      blogEnabled={user.blog_enabled !== 0}
    >
      <StyleForm
        mode="edit"
        detail={detail}
        stylists={stylists}
        coupons={coupons}
        templates={[]}
        imageError={c.req.query('imageError') === '1'}
      />
    </PageLayout>,
    { title: 'スタイル編集' }
  )
})

style.post('/style/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const parsed = parseStyleForm(body)

  const owned = await c.env.DB.prepare('SELECT id FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (!owned) return c.notFound()

  try {
    await saveImageIfProvided(c, user, id, body)
  } catch (err: any) {
    return c.redirect(`/style/${id}/edit?imageError=1`)
  }

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
     WHERE id = ? AND user_id = ? AND salon_id = ?`
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
      user.id,
      user.active_salon_id
    )
    .run()

  return c.redirect('/style/library?saved=1')
})

style.post('/style/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  // 2026-08-13追記(重大バグ修正): 所有権チェックをせずstyle_idだけでS3画像を
  // 削除していたため、他サロンのstyle_idを指定すればそのサロンの画像を
  // 削除できてしまっていた(DB行自体はuser_id条件で守られていたが、
  // 画像だけが孤立して消える実害があった)。まずstyles.user_idで所有権を
  // 確認してから画像削除に進む。
  const owned = await c.env.DB.prepare('SELECT id FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (!owned) return c.redirect('/style/library?deleted=1')

  const images = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE style_id = ?').bind(id).all<{ r2_key: string }>()
  for (const img of images.results || []) {
    await c.env.STYLE_IMAGES.delete(img.r2_key).catch(() => {})
  }

  await c.env.DB.prepare('DELETE FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .run()
  return c.redirect('/style/library?deleted=1')
})

// ---------- Ajax: 自動投稿対象トグル・全選択/解除・削除 ----------

style.post('/api/style/toggle', async (c) => {
  const user = c.get('user')
  const { imageId, selected } = await c.req.json<{ imageId: number; selected: boolean }>()

  await c.env.DB.prepare(
    'UPDATE styles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
  )
    .bind(selected ? 1 : 0, imageId, user.id, user.active_salon_id)
    .run()

  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND salon_id = ? AND auto_post_enabled_flag = 1'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
})

// 登録済みスタイル一覧の全選択/全解除。
style.post('/api/style/toggle-all', async (c) => {
  const user = c.get('user')
  const { selected } = await c.req.json<{ selected: boolean }>()

  await c.env.DB.prepare(
    'UPDATE styles SET auto_post_enabled_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?'
  )
    .bind(selected ? 1 : 0, user.id, user.active_salon_id)
    .run()

  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND salon_id = ? AND auto_post_enabled_flag = 1'
  )
    .bind(user.id, user.active_salon_id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
})

// No.欄の手入力による並び替え。対象スタイルを指定位置(1始まり)へ移動し、
// 残りのスタイルの並び順を詰め直してsort_orderへ連番で書き戻す。
style.post('/api/style/reorder', async (c) => {
  const user = c.get('user')
  const { styleId, newPosition } = await c.req.json<{ styleId: number; newPosition: number }>()

  const { results } = await c.env.DB.prepare(
    'SELECT id FROM styles WHERE user_id = ? AND salon_id = ? ORDER BY sort_order ASC, id DESC'
  )
    .bind(user.id, user.active_salon_id)
    .all<{ id: number }>()

  const ids = (results || []).map((r) => r.id)
  const currentIndex = ids.indexOf(styleId)
  if (currentIndex === -1) {
    return c.json({ success: false, error: '対象のスタイルが見つかりません' }, 404)
  }

  ids.splice(currentIndex, 1)
  const targetIndex = Math.min(Math.max(Math.trunc(newPosition) - 1, 0), ids.length)
  ids.splice(targetIndex, 0, styleId)

  for (let i = 0; i < ids.length; i++) {
    await c.env.DB.prepare(
      'UPDATE styles SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND salon_id = ?'
    )
      .bind(i, ids[i], user.id, user.active_salon_id)
      .run()
  }

  return c.json({ success: true })
})

// テンプレート一括適用(docs/phase3-mvp-design.md 5-4)。
// 画像は変更せず、テンプレート項目(タイトルを除く。担当スタイリストは含む)を反映する。
// タイトルは各スタイル固有のものとして扱い、一括適用では上書きしない。
// 2026-08-12追記: 担当スタイリストもテンプレート側の必須項目として追加し、
// 一括適用時に対象スタイルの担当スタイリストを上書きするようにした。
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
            menu_detail_text, stylist_id, coupon_id, hashtags_json, model_attributes_json
     FROM templates WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(templateId, user.id, user.active_salon_id)
    .first<TemplateForAutofill>()

  if (!template) return c.json({ success: false, error: 'テンプレートが見つかりません' }, 404)

  let appliedCount = 0
  const errors: string[] = []

  for (const styleId of styleIds) {
    try {
      const owned = await c.env.DB.prepare(
        'SELECT id, title, stylist_id FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?'
      )
        .bind(styleId, user.id, user.active_salon_id)
        .first<{ id: number; title: string | null; stylist_id: number | null }>()
      if (!owned) {
        errors.push(`ID ${styleId}: 見つかりません`)
        continue
      }

      // テンプレートに担当スタイリストが設定されていればそれで上書きする。
      // (未設定の旧テンプレートの場合のみ、スタイル側の既存値を維持する)
      const effectiveStylistId = template.stylist_id ?? owned.stylist_id

      await c.env.DB.prepare(
        `UPDATE styles SET
           comment = ?, category_value = ?, length_value = ?, menu_values_json = ?,
           menu_detail_text = ?, stylist_id = ?, coupon_id = ?, hashtags_json = ?, model_attributes_json = ?,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND salon_id = ?`
      )
        .bind(
          template.comment_template,
          template.category_value,
          template.length_value,
          template.menu_values_json,
          template.menu_detail_text,
          effectiveStylistId,
          template.coupon_id,
          template.hashtags_json,
          template.model_attributes_json,
          styleId,
          user.id,
          user.active_salon_id
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
        !!effectiveStylistId

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
    `INSERT INTO batch_template_apply_logs (user_id, salon_id, template_id, applied_count, target_style_ids_json, result_status, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      user.active_salon_id,
      templateId,
      appliedCount,
      JSON.stringify(styleIds),
      resultStatus,
      errors.length > 0 ? errors.join(' / ').slice(0, 1000) : null
    )
    .run()

  return c.json({ success: resultStatus !== 'failed', appliedCount, totalCount: styleIds.length, errors })
})

style.post('/style/library/delete/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const owned = await c.env.DB.prepare('SELECT id FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .first<{ id: number }>()
  if (!owned) return c.json({ error: 'not found' }, 404)

  const images = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE style_id = ?').bind(id).all<{ r2_key: string }>()
  for (const img of images.results || []) {
    await c.env.STYLE_IMAGES.delete(img.r2_key).catch(() => {})
  }
  await c.env.DB.prepare('DELETE FROM styles WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .run()

  return c.json({ success: true })
})

// ---------- 自動投稿・手動投稿 ----------
// 2026-08-16追記(ユーザー指定): このページ(/style/schedule)は「自動更新設定」
// (/settings/auto-update、dashboard.tsx)に統合されたため、GETは単なる
// リダイレクトにした。POSTの action 先・ラベル定数は自動更新設定側から
// そのまま再利用するため残す。

// 自動投稿を停止する時間帯(JST)。src/lib/style-post-runner.tsの
// BLACKOUT_START/END_MINUTESと一致させること。
export const BLACKOUT_START_LABEL = '2:00'
export const BLACKOUT_END_LABEL = '7:00'
// 通常運転時の投稿間隔(分)。src/lib/style-post-runner.tsのPOST_INTERVAL_MINUTESと一致させること。
export const POST_INTERVAL_MINUTES_LABEL = 60

style.get('/style/schedule', (c) => c.redirect('/settings/auto-update'))

style.post('/style/schedule', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()

  const enabled = body.enabled === 'on' || body.enabled === 'true'

  const existing = await c.env.DB.prepare('SELECT id, enabled FROM style_post_schedules WHERE user_id = ? AND salon_id = ?')
    .bind(user.id, user.active_salon_id)
    .first<{ id: number; enabled: number }>()

  // 2026-08-13追記(ユーザー指定ルール): OFF→ONに切り替えた瞬間(既存レコードが
  // 無い=初回ONの場合も含む)、動作確認のため登録順の先頭3件を連続投稿する
  // 「初回バースト」をリセットする。ON→OFF→ONで再度ONにした場合も同様。
  const turningOn = enabled && existing?.enabled !== 1

  if (existing) {
    if (turningOn) {
      await c.env.DB.prepare(
        `UPDATE style_post_schedules
         SET enabled = 1, burst_remaining = ?, next_cursor_style_id = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND salon_id = ?`
      )
        .bind(INITIAL_BURST_COUNT, user.id, user.active_salon_id)
        .run()
    } else {
      await c.env.DB.prepare(
        `UPDATE style_post_schedules SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
      )
        .bind(enabled ? 1 : 0, user.id, user.active_salon_id)
        .run()
    }
  } else {
    await c.env.DB.prepare(
      `INSERT INTO style_post_schedules (user_id, salon_id, enabled, burst_remaining) VALUES (?, ?, ?, ?)`
    )
      .bind(user.id, user.active_salon_id, enabled ? 1 : 0, enabled ? INITIAL_BURST_COUNT : 0)
      .run()
  }

  return c.redirect('/settings/auto-update?saved=1')
})

// 2026-08-14追記(ユーザー指定): 5件連続失敗による5時間の自動一時停止を、
// ユーザーの判断で今すぐ解除できるようにする(原因が解消したにも関わらず
// 5時間待つ必要がないようにするため)。連続失敗カウント自体もリセットし、
// 解除直後にまた5件連続失敗と判定されて即座に再度停止することを防ぐ。
style.post('/style/schedule/clear-pause', async (c) => {
  const user = c.get('user')
  await c.env.DB.prepare(
    `UPDATE style_post_schedules SET paused_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND salon_id = ?`
  )
    .bind(user.id, user.active_salon_id)
    .run()
  await c.env.DB.prepare(`UPDATE users SET consecutive_failure_count = 0 WHERE id = ?`).bind(user.id).run()
  return c.redirect('/settings/auto-update?saved=1')
})

// 2026-08-14追記(ユーザー指定): 「進行中ジョブがある」と判定され続けて
// 自動投稿対象・手動実行対象から除外されているスタイルを、ユーザー自身の
// 判断で今すぐ復旧できるようにする(sweepStaleJobsの15分を待たない)。
style.post('/style/schedule/reset-stuck-jobs', async (c) => {
  const user = c.get('user')
  const clearedCount = await resetStuckJobsForUser(c.env, user.id, user.active_salon_id)
  return c.redirect(`/style/schedule?cleared=${clearedCount}`)
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
      'SELECT id, template_name, title_template, active_flag FROM templates WHERE user_id = ? AND salon_id = ? ORDER BY id DESC'
    )
      .bind(user.id, user.active_salon_id)
      .all<TemplateListRow>(),
    loadStyleListForUser(c, user)
  ])

  const templates = results || []
  const totalCount = styles.length
  const selectedCount = styles.filter((s) => s.auto_post_enabled_flag === 1).length

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-template"
      salonName={user.salon_name}
      title="テンプレート作成・適用"
      blogEnabled={user.blog_enabled !== 0}
    >
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

      <StyleListSection
        styles={styles}
        totalCount={totalCount}
        selectedCount={selectedCount}
        showCreateLink={false}
        heading="テンプレート反映スタイル"
        checkboxMode="template-target"
      />

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
  stylist_id: number | null
  coupon_id: number | null
  hashtags_json: string
  model_attributes_json: string | null
  active_flag: number
}

function TemplateForm({
  mode,
  detail,
  stylists,
  coupons
}: {
  mode: 'new' | 'edit'
  detail: TemplateDetailRow | null
  stylists: { id: number; name: string }[]
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
        <label class="block text-sm font-medium text-gray-700 mb-1">
          長さ<span style="color:#d32475">*</span>
        </label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">メニュー内容（該当するものを選択、任意）</label>
        <div class="flex flex-wrap gap-3 text-sm mb-2">
          {MENU_OPTIONS.map(([v, label]) => (
            <label class="flex items-center gap-1">
              <input type="checkbox" name="menu_values" value={v} checked={menuCodes.includes(v)} />
              {label}
            </label>
          ))}
        </div>
        <label class="block text-sm font-medium text-gray-700 mb-1">
          メニュー内容（テキスト）<span style="color:#d32475">*</span>
        </label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">ハッシュタグ（スラッシュ区切り）</label>
        <input
          type="text"
          name="hashtags"
          value={hashtags.join('/')}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <p class="hashtags-error hidden text-xs text-red-500 mt-1">
          各タグは文字・数字のみ使用できます(空白・記号は使用できません)。
        </p>
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
          <button
            type="submit"
            formaction={`/style/template/${detail?.id}/delete`}
            formmethod="post"
            onclick="return confirm('このテンプレートを削除しますか？')"
            class="px-5 py-2.5 rounded-lg border border-red-200 text-red-500 text-sm font-semibold hover:bg-red-50"
          >
            削除
          </button>
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
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => HASHTAG_ALLOWED_PATTERN.test(s))

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
    stylistId: body.stylist_id ? Number(body.stylist_id) : null,
    couponId: body.coupon_id ? Number(body.coupon_id) : null,
    active: body.active === 'on' || body.active === 'true'
  }
}

style.get('/style/template/new', async (c) => {
  const user = c.get('user')
  const { stylists, coupons } = await loadFormMasters(c, user)
  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-template"
      salonName={user.salon_name}
      title="テンプレート新規作成"
      blogEnabled={user.blog_enabled !== 0}
    >
      <TemplateForm mode="new" detail={null} stylists={stylists} coupons={coupons} />
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
       user_id, salon_id, template_name, title_template, comment_template, category_value, length_value,
       menu_values_json, menu_detail_text, stylist_id, coupon_id, hashtags_json, model_attributes_json, active_flag
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      user.active_salon_id,
      parsed.templateName,
      parsed.titleTemplate,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.stylistId,
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
            menu_detail_text, stylist_id, coupon_id, hashtags_json, model_attributes_json, active_flag
     FROM templates WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(id, user.id, user.active_salon_id)
    .first<TemplateDetailRow>()

  if (!detail) return c.notFound()

  const { stylists, coupons } = await loadFormMasters(c, user)

  return c.render(
    <PageLayout
      seoEnabled={user.seo_enabled !== 0}

      reviewEnabled={user.review_enabled !== 0}
      active="style-template"
      salonName={user.salon_name}
      title="テンプレート編集"
      blogEnabled={user.blog_enabled !== 0}
    >
      <TemplateForm mode="edit" detail={detail} stylists={stylists} coupons={coupons} />
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
       menu_values_json = ?, menu_detail_text = ?, stylist_id = ?, coupon_id = ?, hashtags_json = ?, model_attributes_json = ?,
       active_flag = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ? AND salon_id = ?`
  )
    .bind(
      parsed.templateName,
      parsed.titleTemplate,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.stylistId,
      parsed.couponId,
      JSON.stringify(parsed.hashtags),
      JSON.stringify(parsed.modelAttributes),
      parsed.active ? 1 : 0,
      id,
      user.id,
      user.active_salon_id
    )
    .run()

  return c.redirect('/style/template?saved=1')
})

style.post('/style/template/:id/delete', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM templates WHERE id = ? AND user_id = ? AND salon_id = ?')
    .bind(id, user.id, user.active_salon_id)
    .run()
  return c.redirect('/style/template?deleted=1')
})

export default style
