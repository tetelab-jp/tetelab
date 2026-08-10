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
      setValue('hashtags', (JSON.parse(t.hashtags_json || '[]') || []).join(','))
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
})
