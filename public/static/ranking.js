// フリーワード対策「順位測定」「対策キーワード設定」画面のクライアント処理
// - 中エリア選択に応じて小エリアをAJAXで取得し、選択中エリアが属するservice_area_cdを
//   隠しフィールドへ自動セット(中エリアのoptionが持つdata-service属性から判定)
// - 「登録」ボタン(登録名モーダル → フォーム送信) … 対策キーワード設定
// - 「測定」ボタン(選択したキーワード設定をバックグラウンド測定) … 順位測定
// - 「+キーワードを追加」ボタン(最大20件まで入力枠を表示) … 対策キーワード設定

;(function () {
  var serviceHidden = document.getElementById('service-area')
  var middleSel = document.getElementById('middle-area')
  var smallSel = document.getElementById('small-area')
  var areaLabelInput = document.getElementById('area-label')

  function selectedText(sel) {
    if (!sel || sel.selectedIndex < 0) return ''
    var opt = sel.options[sel.selectedIndex]
    return opt && opt.value ? opt.text : ''
  }

  function updateAreaLabel() {
    var parts = [selectedText(middleSel), selectedText(smallSel)].filter(function (t) {
      return t
    })
    if (areaLabelInput) areaLabelInput.value = parts.join(' > ')
  }

  function fillSelect(sel, options, placeholder) {
    if (!sel) return
    sel.innerHTML = ''
    var ph = document.createElement('option')
    ph.value = ''
    ph.text = placeholder
    sel.appendChild(ph)
    options.forEach(function (o) {
      var el = document.createElement('option')
      el.value = o.code
      el.text = o.name
      sel.appendChild(el)
    })
  }

  async function loadAreas(level, service, middle) {
    var url = '/seo/api/areas?level=' + level + '&service=' + encodeURIComponent(service)
    if (middle) url += '&middle=' + encodeURIComponent(middle)
    var res = await fetch(url)
    var data = await res.json()
    return data.options || []
  }

  if (middleSel) {
    middleSel.addEventListener('change', async function () {
      var selectedOpt = middleSel.options[middleSel.selectedIndex]
      var service = (selectedOpt && selectedOpt.getAttribute('data-service')) || ''
      if (serviceHidden) serviceHidden.value = service

      fillSelect(smallSel, [], '選択してください（任意）')
      updateAreaLabel()
      if (!service || !middleSel.value) return
      smallSel.disabled = true
      try {
        var options = await loadAreas('small', service, middleSel.value)
        fillSelect(smallSel, options, options.length ? '選択してください（任意）' : '小エリアなし（任意）')
      } catch (e) {
        fillSelect(smallSel, [], '選択してください（任意）')
      } finally {
        smallSel.disabled = false
        updateAreaLabel()
      }
    })
  }

  if (smallSel) {
    smallSel.addEventListener('change', updateAreaLabel)
  }

  // 現在の選択(編集画面の初期値など)からエリアラベルを初期化
  updateAreaLabel()

  // 入力チェック(サロン名・中エリア・キーワード1つ以上)
  function collectAndValidate(statusEl) {
    var salonField = document.getElementById('salon-auto-field')
    var hasSalon = !salonField || salonField.getAttribute('data-has-salon') === '1'
    if (!hasSalon) {
      if (statusEl) statusEl.textContent = 'サロン名が未取得です。サロンボードと同期してください'
      return null
    }
    var middle = middleSel ? middleSel.value : ''
    if (!middle) {
      if (statusEl) statusEl.textContent = '中エリアを選択してください'
      return null
    }
    var keywords = []
    for (var i = 0; i < 20; i++) {
      var el = document.getElementById('keyword_' + i)
      if (el && el.value.trim()) keywords.push(el.value.trim())
    }
    if (keywords.length === 0) {
      if (statusEl) statusEl.textContent = 'キーワードを1つ以上入力してください'
      return null
    }
    updateAreaLabel()
    return { middle: middle, keywords: keywords }
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
      updateAreaLabel()
      if (form) form.submit()
    })
  }

  // 「+キーワードを追加」ボタン(隠れているキーワード入力枠を表示、最大20個)
  var addKeywordBtn = document.getElementById('add-keyword-btn')
  if (addKeywordBtn) {
    addKeywordBtn.addEventListener('click', function () {
      document.querySelectorAll('.keyword-slot.hidden').forEach(function (el) {
        el.classList.remove('hidden')
      })
      addKeywordBtn.classList.add('hidden')
    })
  }
})()
