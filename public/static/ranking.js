// フリーワード対策「順位測定」「対策キーワード設定」画面のクライアント処理
// サロン名・対策エリア(中/小)はサロンボード連携+HPBサロンページから自動検出した
// 値をそのまま使うため、選択UI・カスケード取得は無い(#salon-auto-field/#area-auto-field
// のdata属性で「未取得かどうか」だけを送信前チェックする)。
// - 「登録」ボタン(登録名モーダル → フォーム送信) … 対策キーワード設定
// - 「測定」ボタン(選択したキーワード設定をバックグラウンド測定) … 順位測定
// - 「+キーワードを追加」ボタン(最大20件まで入力枠を表示) … 対策キーワード設定

;(function () {
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
    var keywords = []
    for (var i = 0; i < 20; i++) {
      var el = document.getElementById('keyword_' + i)
      if (el && el.value.trim()) keywords.push(el.value.trim())
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

  // 「+キーワードを追加」ボタン(クリック1回につき隠れている枠を1個ずつ表示、最大20個)
  var addKeywordBtn = document.getElementById('add-keyword-btn')
  if (addKeywordBtn) {
    addKeywordBtn.addEventListener('click', function () {
      var hiddenSlots = document.querySelectorAll('.keyword-slot.hidden')
      if (hiddenSlots.length === 0) return
      hiddenSlots[0].classList.remove('hidden')
      if (hiddenSlots.length <= 1) {
        addKeywordBtn.classList.add('hidden')
      }
    })
  }
})()
