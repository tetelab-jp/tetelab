// フリーワード対策「順位測定」「対策キーワード設定」画面のクライアント処理
// サロン名・対策エリア(中/小)はサロンボード連携+HPBサロンページから自動検出した
// 値をそのまま使うため、選択UI・カスケード取得は無い(#salon-auto-field/#area-auto-field
// のdata属性で「未取得かどうか」だけを送信前チェックする)。
// - キーワードは1個の入力欄にEnterまたは「追加」ボタンでチップとして追加(最大20個)
// - 「登録」ボタン(登録名モーダル → フォーム送信) … 対策キーワード設定
// - 「測定」ボタン(選択したキーワード設定をバックグラウンド測定) … 順位測定

;(function () {
  var KEYWORD_MAX = 20

  // ------------------------------------------------
  // キーワードのタグ入力(1個の入力欄 → Enter/追加ボタンでチップ化)
  // 送信用hidden inputはチップの増減に合わせてkeyword_0, keyword_1...と再生成する。
  // ------------------------------------------------
  var keywordInput = document.getElementById('keyword-input')
  var keywordAddBtn = document.getElementById('keyword-add-btn')
  var keywordChips = document.getElementById('keyword-chips')
  var keywordHiddenContainer = document.getElementById('keyword-hidden-container')
  var keywordCountEl = document.getElementById('keyword-count')
  var keywords = keywordHiddenContainer
    ? Array.from(keywordHiddenContainer.querySelectorAll('.keyword-hidden-input')).map(function (el) {
        return el.value
      })
    : []

  function renderKeywords() {
    if (!keywordChips || !keywordHiddenContainer) return

    keywordChips.innerHTML = ''
    keywords.forEach(function (kw, i) {
      var chip = document.createElement('span')
      chip.className =
        'inline-flex items-center gap-1.5 bg-pink-50 text-pink-700 border border-pink-200 rounded-full pl-3 pr-2 py-1 text-sm'
      var text = document.createElement('span')
      text.textContent = kw
      chip.appendChild(text)
      var removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'text-pink-400 hover:text-pink-600 leading-none'
      removeBtn.setAttribute('aria-label', '削除')
      removeBtn.textContent = '×'
      removeBtn.addEventListener('click', function () {
        keywords.splice(i, 1)
        renderKeywords()
      })
      chip.appendChild(removeBtn)
      keywordChips.appendChild(chip)
    })

    keywordHiddenContainer.innerHTML = ''
    keywords.forEach(function (kw, i) {
      var hidden = document.createElement('input')
      hidden.type = 'hidden'
      hidden.name = 'keyword_' + i
      hidden.value = kw
      keywordHiddenContainer.appendChild(hidden)
    })

    if (keywordCountEl) keywordCountEl.textContent = keywords.length
    var atMax = keywords.length >= KEYWORD_MAX
    if (keywordAddBtn) keywordAddBtn.disabled = atMax
    if (keywordInput) keywordInput.disabled = atMax
  }

  function addKeywordFromInput() {
    if (!keywordInput) return
    var v = keywordInput.value.trim()
    if (!v || keywords.length >= KEYWORD_MAX) return
    if (keywords.indexOf(v) === -1) keywords.push(v)
    keywordInput.value = ''
    renderKeywords()
    keywordInput.focus()
  }

  if (keywordAddBtn) keywordAddBtn.addEventListener('click', addKeywordFromInput)
  if (keywordInput) {
    keywordInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        addKeywordFromInput()
      }
    })
  }
  renderKeywords()

  // 入力チェック(サロン名・対策エリアが自動取得済みか、キーワード1つ以上)
  function collectAndValidate(statusEl) {
    var salonField = document.getElementById('salon-auto-field')
    var hasSalon = !salonField || salonField.getAttribute('data-has-salon') === '1'
    if (!hasSalon) {
      if (statusEl) statusEl.textContent = 'サロン名が未取得です。「サロンボード連携設定」で同期してください'
      return null
    }
    var areaField = document.getElementById('area-auto-field')
    var hasArea = !areaField || areaField.getAttribute('data-has-area') === '1'
    if (!hasArea) {
      if (statusEl) statusEl.textContent = '対策エリアが未取得です。「サロンボード連携設定」で同期してください'
      return null
    }
    if (keywords.length === 0) {
      if (statusEl) statusEl.textContent = 'キーワードを1つ以上入力してください'
      return null
    }
    return { keywords: keywords }
  }

  var status = document.getElementById('measure-status')

  // 「測定」ボタン(順位測定ページ: 選択したキーワード設定を測定)
  var measureRunBtn = document.getElementById('measure-run-btn')
  if (measureRunBtn) {
    measureRunBtn.addEventListener('click', async function () {
      var ids = []
      document.querySelectorAll('.tmpl-check:checked').forEach(function (el) {
        ids.push(Number(el.value))
      })
      if (ids.length === 0) {
        if (status) status.textContent = '計測するキーワード設定を選択してください'
        return
      }
      measureRunBtn.disabled = true
      if (status) status.textContent = '測定を開始しています...'
      try {
        var res = await fetch('/seo/measure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queryIds: ids })
        })
        var data = await res.json()
        if (data.success) {
          if (status)
            status.textContent =
              '測定を開始しました（' + data.count + '件）。完了まで少し時間がかかります。まもなく自動更新します...'
          setTimeout(function () {
            location.reload()
          }, 4000)
        } else {
          if (status) status.textContent = 'エラー: ' + (data.error || '不明なエラー')
          measureRunBtn.disabled = false
        }
      } catch (e) {
        if (status) status.textContent = '通信エラーが発生しました'
        measureRunBtn.disabled = false
      }
    })
  }

  // 「登録」ボタン → テンプレート名モーダル
  var openBtn = document.getElementById('register-open-btn')
  var modal = document.getElementById('register-modal')
  var modalName = document.getElementById('modal-template-name')
  var modalError = document.getElementById('modal-error')
  var confirmBtn = document.getElementById('register-confirm-btn')
  var cancelBtn = document.getElementById('register-cancel-btn')
  var form = document.getElementById('ranking-form')
  var nameHidden = document.getElementById('template-name')

  function closeModal() {
    if (modal) modal.classList.add('hidden')
  }

  if (openBtn && modal) {
    openBtn.addEventListener('click', function () {
      var v = collectAndValidate(status)
      if (!v) return
      if (modalError) modalError.textContent = ''
      modal.classList.remove('hidden')
      if (modalName) {
        modalName.value = ''
        modalName.focus()
      }
    })
  }
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal)
  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal()
    })
  }
  if (confirmBtn) {
    confirmBtn.addEventListener('click', function () {
      var name = modalName ? modalName.value.trim() : ''
      if (!name) {
        if (modalError) modalError.textContent = 'テンプレート名を入力してください'
        return
      }
      if (nameHidden) nameHidden.value = name
      if (form) form.submit()
    })
  }
})()
