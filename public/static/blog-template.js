// 生成テンプレートページの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  // 2026-08-17追記(ユーザー指定): フッターのプレビューを直接編集できるように
  // する。サーバー側のbuildAutoFooterText(src/lib/blog-footer.ts)と同じ
  // ロジックをJSで再現し、他の項目(住所・営業時間・区切り記号等)を変更した
  // 際にプレビューへ自動反映する。ただし、ユーザーがプレビュー欄を直接編集して
  // 自動生成結果から乖離した場合は、以後その項目を変更しても上書きしない
  // (「自動生成に戻す」ボタンを押すまでユーザーの編集内容を優先する)。
  // 送信時、プレビュー欄の内容が現在の自動生成結果と一致していれば空文字を
  // 送り(サーバー側でNULL保存→以後も自動生成に追従)、異なっていれば
  // そのままの内容を上書き値として送る。
  ;(function () {
    var textarea = document.getElementById('footer-preview-textarea')
    if (!textarea) return
    var form = textarea.closest('form')
    var resetBtn = document.getElementById('footer-reset-btn')
    var countEl = document.getElementById('footer-preview-count')
    var warningEl = document.getElementById('footer-preview-warning')
    var salonName = textarea.getAttribute('data-salon-name') || ''

    function buildAutoFooterText() {
      var sepChar = (form.querySelector('[name="footer_separator"]') || {}).value || '＊'
      var sep = new Array(17).join(sepChar || '＊')
      var lines = [sep, salonName || '']
      var address = (form.querySelector('[name="address"]') || {}).value || ''
      var nearestStation = (form.querySelector('[name="nearest_station"]') || {}).value || ''
      var walkMinutes = (form.querySelector('[name="walk_minutes"]') || {}).value || ''
      var businessHours = (form.querySelector('[name="business_hours"]') || {}).value || ''
      var closingDays = (form.querySelector('[name="closing_days"]') || {}).value || ''
      var keywordsRaw = (form.querySelector('[name="footer_keywords"]') || {}).value || ''
      if (address || nearestStation) {
        lines.push('', '【アクセス】')
        if (address) lines.push(address)
        if (nearestStation) lines.push(nearestStation + (walkMinutes ? ' 徒歩' + walkMinutes : ''))
      }
      if (businessHours || closingDays) {
        lines.push('', '【営業時間】')
        if (businessHours) lines.push(businessHours)
        if (closingDays) lines.push('※定休：' + closingDays)
      }
      var keywords = keywordsRaw
        .split('/')
        .map(function (k) {
          return k.trim()
        })
        .filter(Boolean)
      if (keywords.length > 0) lines.push('', '[' + keywords.join('/') + ']')
      return lines.join('\n')
    }

    function updateCount() {
      var text = textarea.value
      if (countEl) countEl.textContent = text.length + '文字 / 改行' + (text ? text.split('\n').length : 0) + '行'
      if (warningEl) warningEl.classList.toggle('hidden', text.length <= 350)
    }

    var lastAutoText = textarea.getAttribute('data-auto-text') || ''

    function syncFromOtherFields() {
      var newAutoText = buildAutoFooterText()
      // ユーザーがプレビューを直接編集して自動生成結果から乖離させていない
      // 場合のみ、最新の自動生成結果に追従させる。
      if (textarea.value === lastAutoText) {
        textarea.value = newAutoText
        updateCount()
      }
      lastAutoText = newAutoText
    }

    ;['footer_separator', 'address', 'nearest_station', 'walk_minutes', 'business_hours', 'closing_days', 'footer_keywords'].forEach(
      function (name) {
        var el = form.querySelector('[name="' + name + '"]')
        if (el) el.addEventListener('input', syncFromOtherFields)
      }
    )

    textarea.addEventListener('input', updateCount)

    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        textarea.value = buildAutoFooterText()
        lastAutoText = textarea.value
        updateCount()
      })
    }

    if (form) {
      form.addEventListener('submit', function () {
        if (textarea.value === buildAutoFooterText()) {
          textarea.value = ''
        }
      })
    }
  })()
  // 伝えたいことのAI下書き生成
  var draftBtn = document.getElementById('generate-draft-btn')
  if (draftBtn) {
    draftBtn.addEventListener('click', async function () {
      var categoryId = draftBtn.getAttribute('data-category-id')
      var textarea = document.getElementById('key-message-input')
      draftBtn.disabled = true
      draftBtn.textContent = '生成中...'
      try {
        var res = await fetch(`/api/blog/categories/${categoryId}/generate-draft`, { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          textarea.value = data.draft
        } else {
          alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
        }
      } catch (e) {
        alert('通信エラーが発生しました')
      } finally {
        draftBtn.disabled = false
        draftBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>AIで下書き生成'
      }
    })
  }
  // 既存テンプレート編集: プレースホルダーのまま(未選択)では開けないようにする
  var templateEditSelect = document.getElementById('template-edit-select')
  var templateEditOpenBtn = document.getElementById('template-edit-open-btn')
  if (templateEditSelect && templateEditOpenBtn) {
    templateEditSelect.addEventListener('change', function () {
      templateEditOpenBtn.disabled = !templateEditSelect.value
    })
    templateEditOpenBtn.addEventListener('click', function () {
      if (!templateEditSelect.value) return
      location.href = '/blog/template?category=' + encodeURIComponent(templateEditSelect.value)
    })
  }
})
