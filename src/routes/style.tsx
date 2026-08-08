import { Hono, type Context } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
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

function statusBadge(status: string, kind: 'internal' | 'register' | 'reflection') {
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
    success: kind === 'reflection' ? '公開済み' : '成功',
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

style.get('/style/library', async (c) => {
  const user = c.get('user')

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

  const styles = results || []
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
          自動投稿スケジュール（<a href="/style/schedule" class="text-pink-600 hover:underline">設定はこちら</a>）で
          設定した時刻に、サロンボードへの登録＋反映申請まで自動で実行されます。
        </p>
      </div>

      <div class="flex items-center justify-between flex-wrap gap-2">
        <p class="font-semibold">
          <i class="fas fa-portrait mr-2 text-pink-500"></i>登録済みスタイル（{totalCount}件）
        </p>
        <div class="flex items-center gap-3">
          <span class="text-sm text-gray-600">
            自動投稿対象:{' '}
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
          <a
            href="/style/new"
            class="bg-pink-500 hover:bg-pink-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg"
          >
            <i class="fas fa-plus mr-1"></i>新規作成
          </a>
        </div>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        {styles.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-10">
            まだスタイルが登録されていません。「新規作成」から追加してください。
          </p>
        ) : (
          <div id="image-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {styles.map((s) => (
              <div class="relative border border-gray-200 rounded-lg overflow-hidden group" data-image-id={s.id}>
                <label class="block cursor-pointer">
                  {s.front_style_image_id ? (
                    <img src={`/style/image/${s.front_style_image_id}`} class="w-full h-32 object-cover" loading="lazy" />
                  ) : (
                    <div class="w-full h-32 bg-gray-50 flex items-center justify-center text-gray-300">
                      <i class="fas fa-image text-2xl"></i>
                    </div>
                  )}
                  <input
                    type="checkbox"
                    class="style-checkbox absolute top-2 left-2 w-5 h-5 accent-pink-500 cursor-pointer"
                    checked={s.auto_post_enabled_flag === 1}
                    data-image-id={s.id}
                  />
                </label>
                <div class="p-2 text-xs text-gray-500 space-y-1">
                  <a href={`/style/${s.id}/edit`} class="block truncate font-medium text-gray-700 hover:text-pink-600">
                    {s.title || '（無題）'}
                  </a>
                  <p class="text-[10px] text-gray-400">{s.stylist_name || '担当未設定'}</p>
                  <div class="flex flex-wrap gap-1">
                    {statusBadge(s.internal_save_status, 'internal')}
                    {statusBadge(s.reflection_request_status, 'reflection')}
                  </div>
                </div>
                <button
                  type="button"
                  class="delete-btn absolute top-2 right-2 bg-white/90 hover:bg-red-50 text-red-500 rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition"
                  data-image-id={s.id}
                  title="削除"
                >
                  <i class="fas fa-xmark"></i>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
  auto_post_enabled_flag: number
  front_style_image_id: number | null
}

function StyleForm({
  mode,
  detail,
  stylists,
  coupons
}: {
  mode: 'new' | 'edit'
  detail: StyleDetailRow | null
  stylists: { id: number; name: string }[]
  coupons: { id: number; name: string }[]
}) {
  const category = detail?.category_value || 'SG01'
  const menuCodes: string[] = detail ? JSON.parse(detail.menu_values_json || '[]') : []
  const hashtags: string[] = detail ? JSON.parse(detail.hashtags_json || '[]') : []
  const action = mode === 'new' ? '/style/new' : `/style/${detail?.id}/edit`

  return (
    <form method="post" action={action} enctype="multipart/form-data" class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-2xl">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">スタイル画像（FRONT）</label>
        {detail?.front_style_image_id && (
          <img src={`/style/image/${detail.front_style_image_id}`} class="w-32 h-40 object-cover rounded-lg border border-gray-200 mb-2" />
        )}
        <input type="file" name="image" accept="image/*" class="block w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">担当スタイリスト</label>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">クーポン（任意）</label>
          <select name="coupon_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="">なし</option>
            {coupons.map((cp) => (
              <option value={cp.id} selected={detail?.coupon_id === cp.id}>{cp.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">スタイル名（最大60文字）</label>
        <input
          type="text"
          name="title"
          maxlength={60}
          value={detail?.title || ''}
          required
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">メニュー内容</label>
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
          maxlength={100}
          placeholder="メニュー内容（最大100文字）"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.menu_detail_text || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">スタイリストコメント（最大240文字）</label>
        <textarea
          name="comment"
          rows={4}
          maxlength={240}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.comment || ''}</textarea>
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
  const { stylists, coupons } = await loadFormMasters(c, user)
  return c.render(
    <PageLayout active="style-library" salonName={user.salon_name} title="スタイル新規作成">
      <StyleForm mode="new" detail={null} stylists={stylists} coupons={coupons} />
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
    title: String(body.title || '').trim().slice(0, 60),
    comment: String(body.comment || '').trim().slice(0, 240),
    categoryValue: category,
    lengthValue,
    menuValues,
    menuDetailText: String(body.menu_detail_text || '').trim().slice(0, 100),
    hashtags,
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
       menu_values_json, menu_detail_text, hashtags_json, auto_post_enabled_flag, internal_save_status
     ) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
            s.menu_values_json, s.menu_detail_text, s.hashtags_json, s.auto_post_enabled_flag,
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
      <StyleForm mode="edit" detail={detail} stylists={stylists} coupons={coupons} />
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
       menu_values_json = ?, menu_detail_text = ?, hashtags_json = ?, auto_post_enabled_flag = ?,
       internal_save_status = ?, updated_at = CURRENT_TIMESTAMP
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

// ---------- 自動投稿スケジュール設定 ----------

style.get('/style/schedule', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const schedule = await c.env.DB.prepare(
    'SELECT enabled, times_per_day, run_times FROM style_post_schedules WHERE user_id = ?'
  )
    .bind(user.id)
    .first<{ enabled: number; times_per_day: number; run_times: string }>()

  const runTimes: string[] = schedule ? JSON.parse(schedule.run_times) : ['10:00']
  const enabled = schedule?.enabled === 1

  const selectedRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM styles WHERE user_id = ? AND auto_post_enabled_flag = 1 AND internal_save_status = 'ready'"
  )
    .bind(user.id)
    .first<{ cnt: number }>()
  const selectedCount = selectedRow?.cnt ?? 0

  return c.render(
    <PageLayout active="style-schedule" salonName={user.salon_name} title="スタイル自動投稿スケジュール">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="bg-blue-50 border border-blue-200 rounded-xl p-5 text-sm text-blue-800">
        <i class="fas fa-circle-info mr-2"></i>
        現在<b>{selectedCount}件</b>のスタイルが自動投稿対象（入力完了済み）です。設定した実行時刻ごとに、この
        <b>{selectedCount}件すべて</b>の「登録＋反映申請」が自動実行されます。
      </div>

      <form method="post" action="/style/schedule" class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-xl">
        <label class="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input type="checkbox" name="enabled" checked={enabled} class="w-4 h-4 accent-pink-500" />
          自動投稿を有効にする
        </label>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">1日の投稿回数</label>
          <select name="times_per_day" id="times-per-day-select" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {[1, 2, 3, 4, 5].map((n) => (
              <option value={n} selected={runTimes.length === n}>
                {n}回
              </option>
            ))}
          </select>
        </div>

        <div id="run-times-container" class="space-y-2">
          <label class="block text-sm font-medium text-gray-700 mb-1">実行時刻</label>
          {[0, 1, 2, 3, 4].map((i) => (
            <input
              type="time"
              name="run_time_slot"
              value={runTimes[i] || ''}
              class={'run-time-input rounded-lg border border-gray-300 px-3 py-2 text-sm mr-2 ' + (i < runTimes.length ? '' : 'hidden')}
              data-index={i}
            />
          ))}
        </div>

        <button
          type="submit"
          class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
        >
          保存する
        </button>
      </form>

      <script src="/static/style-schedule.js"></script>
    </PageLayout>,
    { title: 'スタイル自動投稿スケジュール' }
  )
})

style.post('/style/schedule', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody({ all: true })

  const enabled = body.enabled === 'on' || body.enabled === 'true'
  const timesPerDay = Number(body.times_per_day) || 1

  const rawSlots = body.run_time_slot
  const slotArray: string[] = Array.isArray(rawSlots) ? (rawSlots as string[]) : rawSlots ? [rawSlots as string] : []
  const runTimes = slotArray.filter((t) => t && t.trim() !== '').slice(0, timesPerDay)

  const finalRunTimes = runTimes.length > 0 ? runTimes : ['10:00']

  const existing = await c.env.DB.prepare('SELECT id FROM style_post_schedules WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE style_post_schedules SET enabled = ?, times_per_day = ?, run_times = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    )
      .bind(enabled ? 1 : 0, finalRunTimes.length, JSON.stringify(finalRunTimes), user.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO style_post_schedules (user_id, enabled, times_per_day, run_times) VALUES (?, ?, ?, ?)`
    )
      .bind(user.id, enabled ? 1 : 0, finalRunTimes.length, JSON.stringify(finalRunTimes))
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
  category_value: string | null
  length_value: string | null
  active_flag: number
}

style.get('/style/template', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const { results } = await c.env.DB.prepare(
    'SELECT id, template_name, category_value, length_value, active_flag FROM templates WHERE user_id = ? ORDER BY id DESC'
  )
    .bind(user.id)
    .all<TemplateListRow>()

  const templates = results || []

  return c.render(
    <PageLayout active="style-template" salonName={user.salon_name} title="投稿テンプレート設定">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="flex items-center justify-between">
        <p class="font-semibold">
          <i class="fas fa-sliders mr-2 text-pink-500"></i>テンプレート一覧（{templates.length}件）
        </p>
        <a href="/style/template/new" class="bg-pink-500 hover:bg-pink-600 text-white text-xs font-semibold px-3 py-1.5 rounded-lg">
          <i class="fas fa-plus mr-1"></i>新規作成
        </a>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        {templates.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-6">まだテンプレートが登録されていません。</p>
        ) : (
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-400 border-b border-gray-100">
                <th class="py-2">テンプレート名</th>
                <th class="py-2">カテゴリ</th>
                <th class="py-2">長さ</th>
                <th class="py-2">状態</th>
                <th class="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr class="border-b border-gray-50">
                  <td class="py-2">
                    <a href={`/style/template/${t.id}/edit`} class="text-pink-600 hover:underline">{t.template_name}</a>
                  </td>
                  <td class="py-2">{t.category_value === 'SG02' ? 'メンズ' : 'レディース'}</td>
                  <td class="py-2">{t.length_value || '-'}</td>
                  <td class="py-2">{t.active_flag === 1 ? '有効' : '停止中'}</td>
                  <td class="py-2 text-right">
                    <a href={`/style/template/${t.id}/edit`} class="text-xs text-gray-400 hover:text-pink-600">編集</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PageLayout>,
    { title: '投稿テンプレート設定' }
  )
})

type TemplateDetailRow = {
  id: number
  template_name: string
  comment_template: string | null
  category_value: string | null
  length_value: string | null
  menu_values_json: string
  menu_detail_text: string | null
  coupon_id: number | null
  hashtags_json: string
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
  const action = mode === 'new' ? '/style/template/new' : `/style/template/${detail?.id}/edit`

  return (
    <form method="post" action={action} class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-2xl">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">テンプレート名</label>
        <input
          type="text"
          name="template_name"
          required
          value={detail?.template_name || ''}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">メニュー内容</label>
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
          maxlength={100}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.menu_detail_text || ''}</textarea>
      </div>

      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">コメント雛形（最大240文字）</label>
        <textarea
          name="comment_template"
          rows={4}
          maxlength={240}
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >{detail?.comment_template || ''}</textarea>
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
    commentTemplate: String(body.comment_template || '').trim().slice(0, 240),
    categoryValue: category,
    lengthValue,
    menuValues,
    menuDetailText: String(body.menu_detail_text || '').trim().slice(0, 100),
    hashtags,
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
       user_id, template_name, comment_template, category_value, length_value,
       menu_values_json, menu_detail_text, coupon_id, hashtags_json, active_flag
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      user.id,
      parsed.templateName,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.couponId,
      JSON.stringify(parsed.hashtags),
      parsed.active ? 1 : 0
    )
    .run()

  return c.redirect('/style/template?saved=1')
})

style.get('/style/template/:id/edit', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const detail = await c.env.DB.prepare(
    `SELECT id, template_name, comment_template, category_value, length_value, menu_values_json,
            menu_detail_text, coupon_id, hashtags_json, active_flag
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
       template_name = ?, comment_template = ?, category_value = ?, length_value = ?,
       menu_values_json = ?, menu_detail_text = ?, coupon_id = ?, hashtags_json = ?, active_flag = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND user_id = ?`
  )
    .bind(
      parsed.templateName,
      parsed.commentTemplate,
      parsed.categoryValue,
      parsed.lengthValue,
      JSON.stringify(parsed.menuValues),
      parsed.menuDetailText,
      parsed.couponId,
      JSON.stringify(parsed.hashtags),
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
