import { Hono } from 'hono'
import { requireAuth } from '../lib/auth-middleware'
import { PageLayout } from '../components/layout'
import type { Bindings, AppUser } from '../types'

const style = new Hono<{ Bindings: Bindings; Variables: { user: AppUser } }>()

style.use('*', requireAuth)

type StyleImageRow = {
  id: number
  r2_key: string
  file_name: string | null
  title: string | null
  category: string | null
  is_selected: number
  post_count: number
  last_posted_at: string | null
}

// ---------- 画像ライブラリ画面 ----------

style.get('/style/library', async (c) => {
  const user = c.get('user')

  const { results } = await c.env.DB.prepare(
    `SELECT id, r2_key, file_name, title, category, is_selected, post_count, last_posted_at
     FROM style_images WHERE user_id = ? ORDER BY sort_order ASC, id DESC`
  )
    .bind(user.id)
    .all<StyleImageRow>()

  const images = results || []
  const totalCount = images.length
  const selectedCount = images.filter((img) => img.is_selected === 1).length

  return c.render(
    <PageLayout active="style-library" salonName={user.salon_name} title="スタイル画像ライブラリ">
      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-2">
          <i class="fas fa-circle-info mr-2 text-pink-500"></i>使い方
        </p>
        <p class="text-sm text-gray-600 leading-relaxed">
          スタイル写真を事前に一括アップロードしておき、投稿したい画像だけチェックを入れてください。
          自動投稿スケジュール（<a href="/style/schedule" class="text-pink-600 hover:underline">設定はこちら</a>）で設定した回数分、
          <b>チェックが入っている画像すべて</b>が1回の実行でサロンボードへ投稿されます。
        </p>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <p class="font-semibold mb-3">
          <i class="fas fa-upload mr-2 text-pink-500"></i>画像を一括アップロード
        </p>
        <form
          id="upload-form"
          method="post"
          action="/style/library/upload"
          enctype="multipart/form-data"
          class="space-y-3"
        >
          <input
            type="file"
            name="images"
            accept="image/*"
            multiple
            required
            class="block w-full text-sm border border-gray-300 rounded-lg px-3 py-2"
          />
          <button
            type="submit"
            class="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
          >
            アップロードする
          </button>
          <p class="text-xs text-gray-400">複数枚まとめて選択できます。（1回のアップロードで最大30枚まで）</p>
        </form>
      </div>

      <div class="bg-white rounded-xl border border-gray-100 p-6">
        <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
          <p class="font-semibold">
            <i class="fas fa-images mr-2 text-pink-500"></i>登録済み画像（{totalCount}枚）
          </p>
          <div class="flex items-center gap-3">
            <span class="text-sm text-gray-600">
              投稿対象:{' '}
              <span id="selected-count" class="font-bold text-pink-600">
                {selectedCount}
              </span>{' '}
              / {totalCount} 枚
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
          </div>
        </div>

        {images.length === 0 ? (
          <p class="text-sm text-gray-400 text-center py-10">まだ画像が登録されていません。上のフォームからアップロードしてください。</p>
        ) : (
          <div id="image-grid" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {images.map((img) => (
              <div
                class="relative border border-gray-200 rounded-lg overflow-hidden group"
                data-image-id={img.id}
              >
                <label class="block cursor-pointer">
                  <img
                    src={`/style/library/image/${img.id}`}
                    class="w-full h-32 object-cover"
                    loading="lazy"
                  />
                  <input
                    type="checkbox"
                    class="style-checkbox absolute top-2 left-2 w-5 h-5 accent-pink-500 cursor-pointer"
                    checked={img.is_selected === 1}
                    data-image-id={img.id}
                  />
                </label>
                <div class="p-2 text-xs text-gray-500">
                  <p class="truncate">{img.title || img.file_name || '（無題）'}</p>
                  <p class="text-[10px] text-gray-400">投稿回数: {img.post_count}回</p>
                </div>
                <button
                  type="button"
                  class="delete-btn absolute top-2 right-2 bg-white/90 hover:bg-red-50 text-red-500 rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition"
                  data-image-id={img.id}
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
    { title: 'スタイル画像ライブラリ' }
  )
})

// ---------- 画像取得（R2から配信、画像IDベース） ----------

style.get('/style/library/image/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  // 所有者チェック：他人の画像に画像IDを推測してアクセスされないようDBで確認
  const owned = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE user_id = ? AND id = ?')
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

// ---------- 画像アップロード ----------

style.post('/style/library/upload', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody({ all: true })
  const files = body['images']
  const fileList: File[] = Array.isArray(files) ? (files as File[]) : files ? [files as File] : []

  const MAX_FILES = 30
  const targets = fileList.filter((f) => f && f.size > 0).slice(0, MAX_FILES)

  if (targets.length === 0) {
    return c.redirect('/style/library?error=' + encodeURIComponent('画像が選択されていません'))
  }

  let sortOrderRow = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) as maxOrder FROM style_images WHERE user_id = ?')
    .bind(user.id)
    .first<{ maxOrder: number }>()
  let nextOrder = (sortOrderRow?.maxOrder || 0) + 1

  for (const file of targets) {
    const arrayBuffer = await file.arrayBuffer()
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    const key = `style/${user.id}/${Date.now()}-${crypto.randomUUID()}.${ext}`

    await c.env.STYLE_IMAGES.put(key, arrayBuffer, {
      httpMetadata: { contentType: file.type || 'image/jpeg' }
    })

    await c.env.DB.prepare(
      `INSERT INTO style_images (user_id, r2_key, file_name, is_selected, sort_order)
       VALUES (?, ?, ?, 1, ?)`
    )
      .bind(user.id, key, file.name, nextOrder)
      .run()
    nextOrder++
  }

  return c.redirect('/style/library?uploaded=' + targets.length)
})

// ---------- 画像削除 ----------

style.post('/style/library/delete/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))

  const img = await c.env.DB.prepare('SELECT r2_key FROM style_images WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<{ r2_key: string }>()

  if (!img) return c.json({ error: 'not found' }, 404)

  await c.env.STYLE_IMAGES.delete(img.r2_key)
  await c.env.DB.prepare('DELETE FROM style_images WHERE id = ? AND user_id = ?').bind(id, user.id).run()

  return c.json({ success: true })
})

// ---------- チェック状態の切り替え（Ajax） ----------

style.post('/api/style/toggle', async (c) => {
  const user = c.get('user')
  const { imageId, selected } = await c.req.json<{ imageId: number; selected: boolean }>()

  await c.env.DB.prepare('UPDATE style_images SET is_selected = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?')
    .bind(selected ? 1 : 0, imageId, user.id)
    .run()

  const row = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM style_images WHERE user_id = ? AND is_selected = 1')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
})

// ---------- 全選択・全解除（Ajax） ----------

style.post('/api/style/bulk-select', async (c) => {
  const user = c.get('user')
  const { selected } = await c.req.json<{ selected: boolean }>()

  await c.env.DB.prepare('UPDATE style_images SET is_selected = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
    .bind(selected ? 1 : 0, user.id)
    .run()

  const row = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM style_images WHERE user_id = ? AND is_selected = 1')
    .bind(user.id)
    .first<{ cnt: number }>()

  return c.json({ success: true, selectedCount: row?.cnt ?? 0 })
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

  const selectedRow = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM style_images WHERE user_id = ? AND is_selected = 1')
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
        現在<b>{selectedCount}枚</b>の画像が投稿対象としてチェックされています。設定した実行時刻ごとに、この
        <b>{selectedCount}枚すべて</b>が自動投稿されます（例: 3回設定の場合、1日合計 {selectedCount * 3} 枚投稿）。
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

// ---------- 投稿テンプレート設定 ----------
// Phase3の自動投稿で使う「スタイリスト・カテゴリ・コメント等」の共通設定。
// サロンボードのスタイル投稿フォームは画像1枚ごとにこれらの必須入力があるが、
// 事前登録した画像プールから毎日自動投稿する運用のため、共通テンプレートとして
// 1回設定すれば全画像に適用される。

type StyleTemplateRow = {
  stylist_select_value: string | null
  stylist_comment: string | null
  category_cd: string
  hair_length_value: string | null
  menu_contents_cd_list: string
  menu_detail_text: string | null
}

style.get('/style/template', async (c) => {
  const user = c.get('user')
  const saved = c.req.query('saved')

  const tpl = await c.env.DB.prepare(
    `SELECT stylist_select_value, stylist_comment, category_cd, hair_length_value, menu_contents_cd_list, menu_detail_text
     FROM style_post_templates WHERE user_id = ?`
  )
    .bind(user.id)
    .first<StyleTemplateRow>()

  const menuCodes: string[] = tpl ? JSON.parse(tpl.menu_contents_cd_list || '[]') : []

  return c.render(
    <PageLayout active="style-template" salonName={user.salon_name} title="投稿テンプレート設定">
      {saved && (
        <div class="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-3">
          <i class="fas fa-circle-check mr-2"></i>保存しました
        </div>
      )}

      <div class="bg-amber-50 border border-amber-200 rounded-xl p-5 text-sm text-amber-800">
        <i class="fas fa-triangle-exclamation mr-2"></i>
        ここで設定した内容が、自動投稿されるすべてのスタイル投稿に共通で使われます。
        「スタイリスト選択値」「ヘアレングス値」はサロンボード側の実際の選択肢に対応する値が必要です。
        サロンボードのスタイル投稿編集画面で該当項目をブラウザの開発者ツールで確認し、正しい値を入力してください。
      </div>

      <form method="post" action="/style/template" class="bg-white rounded-xl border border-gray-100 p-6 space-y-5 max-w-xl">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
          <select name="category_cd" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            <option value="SG01" selected={!tpl || tpl.category_cd === 'SG01'}>レディース</option>
            <option value="SG02" selected={tpl?.category_cd === 'SG02'}>メンズ</option>
          </select>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            スタイリスト選択値
            <span class="text-xs text-gray-400 ml-1">(#stylistCheckCdのoption value)</span>
          </label>
          <input
            type="text"
            name="stylist_select_value"
            value={tpl?.stylist_select_value || ''}
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">
            ヘアレングス選択値
            <span class="text-xs text-gray-400 ml-1">(ladiesHairLengthCd/mensHairLengthCdのoption value)</span>
          </label>
          <input
            type="text"
            name="hair_length_value"
            value={tpl?.hair_length_value || ''}
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">メニュー内容（任意・カンマ区切り MC01,MC02...）</label>
          <input
            type="text"
            name="menu_contents_cd_list"
            value={menuCodes.join(',')}
            placeholder="MC01,MC03"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">メニュー詳細（必須・最大100文字）</label>
          <textarea
            name="menu_detail_text"
            rows={2}
            maxlength={100}
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >{tpl?.menu_detail_text || ''}</textarea>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">スタイリストコメント（必須・最大240文字）</label>
          <textarea
            name="stylist_comment"
            rows={4}
            maxlength={240}
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >{tpl?.stylist_comment || ''}</textarea>
        </div>

        <button
          type="submit"
          class="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold py-2.5 rounded-lg transition"
        >
          保存する
        </button>
      </form>
    </PageLayout>,
    { title: '投稿テンプレート設定' }
  )
})

style.post('/style/template', async (c) => {
  const user = c.get('user')
  const body = await c.req.parseBody()

  const categoryCd = String(body.category_cd || 'SG01')
  const stylistSelectValue = String(body.stylist_select_value || '').trim()
  const hairLengthValue = String(body.hair_length_value || '').trim()
  const menuDetailText = String(body.menu_detail_text || '').trim().slice(0, 100)
  const stylistComment = String(body.stylist_comment || '').trim().slice(0, 240)
  const menuCodes = String(body.menu_contents_cd_list || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const existing = await c.env.DB.prepare('SELECT id FROM style_post_templates WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: number }>()

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE style_post_templates
       SET category_cd = ?, stylist_select_value = ?, hair_length_value = ?, menu_contents_cd_list = ?, menu_detail_text = ?, stylist_comment = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    )
      .bind(categoryCd, stylistSelectValue, hairLengthValue, JSON.stringify(menuCodes), menuDetailText, stylistComment, user.id)
      .run()
  } else {
    await c.env.DB.prepare(
      `INSERT INTO style_post_templates (user_id, category_cd, stylist_select_value, hair_length_value, menu_contents_cd_list, menu_detail_text, stylist_comment)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(user.id, categoryCd, stylistSelectValue, hairLengthValue, JSON.stringify(menuCodes), menuDetailText, stylistComment)
      .run()
  }

  return c.redirect('/style/template?saved=1')
})

export default style
