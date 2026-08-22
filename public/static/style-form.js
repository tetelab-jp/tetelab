// スタイル/テンプレート作成・編集フォームの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  const categoryRadios = document.querySelectorAll('.category-radio')
  const lengthSelects = document.querySelectorAll('.length-select')
  // ページ内には他にもフォーム(サイドバーのログアウト等)が存在するため、
  // document.querySelector('form')ではなく、category-radioを含む実際のフォームを特定する
  const form = categoryRadios[0] ? categoryRadios[0].closest('form') : null

  // カテゴリ（レディース/メンズ）に応じて、対応する「長さ」セレクトのみ表示する
  function updateLengthSelects() {
    const checked = document.querySelector('.category-radio:checked')
    const activeCat = checked ? checked.value : 'SG01'
    lengthSelects.forEach((select) => {
      if (select.dataset.cat === activeCat) {
        select.classList.remove('hidden')
      } else {
        select.classList.add('hidden')
        select.value = ''
      }
    })
  }

  categoryRadios.forEach((radio) => {
    radio.addEventListener('change', updateLengthSelects)
  })

  if (categoryRadios.length > 0) {
    updateLengthSelects()
  }

  // テンプレートから作成: 選択したテンプレートの内容を画像以外の全項目に自動入力する
  const templateSelect = document.getElementById('template-select')
  const templateDataEl = document.getElementById('template-data')
  if (templateSelect && templateDataEl && form) {
    let templates = []
    try {
      templates = JSON.parse(templateDataEl.textContent || '[]')
    } catch (e) {
      templates = []
    }

    templateSelect.addEventListener('change', () => {
      const id = Number(templateSelect.value)
      const t = templates.find((tpl) => tpl.id === id)
      if (!t) return

      const setValue = (name, value) => {
        const el = form.querySelector(`[name="${name}"]`)
        if (el) el.value = value || ''
      }

      setValue('title', t.title_template)
      setValue('comment', t.comment_template)
      setValue('menu_detail_text', t.menu_detail_text)
      setValue('hashtags', (JSON.parse(t.hashtags_json || '[]') || []).join('/'))
      setValue('stylist_id', t.stylist_id != null ? String(t.stylist_id) : '')
      setValue('coupon_id', t.coupon_id != null ? String(t.coupon_id) : '')

      const category = t.category_value || 'SG01'
      const categoryRadio = form.querySelector(`.category-radio[value="${category}"]`)
      if (categoryRadio) {
        categoryRadio.checked = true
        updateLengthSelects()
      }

      const lengthFieldName = category === 'SG01' ? 'length_value_sg01' : 'length_value_sg02'
      setValue(lengthFieldName, t.length_value)

      const menuValues = JSON.parse(t.menu_values_json || '[]') || []
      form.querySelectorAll('[name="menu_values"]').forEach((cb) => {
        cb.checked = menuValues.includes(cb.value)
      })

      let model = {}
      try {
        model = JSON.parse(t.model_attributes_json || '{}') || {}
      } catch (e) {
        model = {}
      }
      setValue('model_hair_volume', model.hairVolume || '99')
      setValue('model_hair_quality', model.hairQuality || '99')
      setValue('model_hair_thickness', model.hairThickness || '99')
      setValue('model_curl', model.curl || '99')
      setValue('model_face_type', model.faceType || '99')
      setValue('model_age', model.age || '99')
    })
  }

  // ハッシュタグ欄: 半角スラッシュ(/)区切りの各タグを文字・数字のみに限定する
  // (サーバー側のHASHTAG_ALLOWED_PATTERNと同じ基準)。全角スラッシュ(／)や
  // それ以外の記号(#!?など)、タグ内の空白は保存時にサーバー側で無言で除外
  // されてしまうため、クライアント側でも同じ基準でチェックしてエラー表示する。
  const hashtagsInput = form ? form.querySelector('input[name="hashtags"]') : null
  const hashtagsError = form ? form.querySelector('.hashtags-error') : null
  const hashtagsCount = form ? form.querySelector('.hashtags-count') : null
  const HASHTAG_TAG_PATTERN = /^[\p{L}\p{N}]+$/u
  const MAX_HASHTAGS = 20

  function getHashtagsList() {
    if (!hashtagsInput) return []
    return hashtagsInput.value
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean)
  }

  function isHashtagsValid() {
    const tags = getHashtagsList()
    return tags.length <= MAX_HASHTAGS && tags.every((tag) => HASHTAG_TAG_PATTERN.test(tag))
  }

  function updateHashtagsError() {
    if (!hashtagsInput) return
    if (hashtagsCount) {
      const count = getHashtagsList().length
      hashtagsCount.textContent = `${count}/${MAX_HASHTAGS}個`
      hashtagsCount.classList.toggle('text-red-500', count > MAX_HASHTAGS)
      hashtagsCount.classList.toggle('text-gray-400', count <= MAX_HASHTAGS)
    }
    if (hashtagsError) {
      hashtagsError.classList.toggle('hidden', isHashtagsValid())
    }
  }

  if (hashtagsInput) {
    hashtagsInput.addEventListener('input', updateHashtagsError)
    updateHashtagsError()
  }

  // 必須項目の入力チェック: 未入力の間は作成/更新ボタンを非活性風の見た目にし、
  // 実際に送信しようとした場合はポップアップで警告して送信を止める。
  // フォームの種類(スタイル/テンプレート)によって存在するフィールドが異なるため、
  // 対象フィールドが存在する場合のみチェック対象に加える。
  const submitBtn = form ? form.querySelector('button[type="submit"]') : null
  if (form && submitBtn) {
    const hasExistingImage = form.dataset.hasExistingImage === 'true'

    function isRequiredFieldsFilled() {
      const checks = [isHashtagsValid()]

      const imageInput = form.querySelector('input[name="image"]')
      if (imageInput) {
        checks.push((imageInput.files && imageInput.files.length > 0) || hasExistingImage)
      }

      const templateNameInput = form.querySelector('input[name="template_name"]')
      if (templateNameInput) {
        checks.push(templateNameInput.value.trim() !== '')
      }

      const stylistSelect = form.querySelector('select[name="stylist_id"]')
      if (stylistSelect) {
        checks.push(stylistSelect.value !== '')
      }

      const commentField = form.querySelector('textarea[name="comment"]')
      if (commentField) {
        checks.push(commentField.value.trim() !== '')
      }

      const titleInput = form.querySelector('input[name="title"], input[name="title_template"]')
      if (titleInput) {
        checks.push(titleInput.value.trim() !== '')
      }

      if (categoryRadios.length > 0) {
        checks.push(!!form.querySelector('.category-radio:checked'))
      }

      if (lengthSelects.length > 0) {
        const visibleLengthSelect = Array.from(lengthSelects).find((select) => !select.classList.contains('hidden'))
        checks.push(!!visibleLengthSelect && visibleLengthSelect.value !== '')
      }

      const menuDetailField = form.querySelector('textarea[name="menu_detail_text"]')
      if (menuDetailField) {
        checks.push(menuDetailField.value.trim() !== '')
      }

      return checks.every(Boolean)
    }

    function updateSubmitButtonAppearance() {
      if (isRequiredFieldsFilled()) {
        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed')
      } else {
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed')
      }
    }

    form.addEventListener('input', updateSubmitButtonAppearance)
    form.addEventListener('change', updateSubmitButtonAppearance)
    updateSubmitButtonAppearance()

    form.addEventListener('submit', (e) => {
      if (!isHashtagsValid()) {
        e.preventDefault()
        updateHashtagsError()
        alert('ハッシュタグは20個まで、各タグは文字・数字のみ使用できます(空白・記号は使用できません)。')
        return
      }
      if (!isRequiredFieldsFilled()) {
        e.preventDefault()
        alert('必須項目が入力されていません。')
      }
    })
  }
})
