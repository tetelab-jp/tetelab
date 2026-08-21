// フリーワード対策「順位測定」「対策キーワード設定」画面のクライアント処理
// サロン名・対策エリア(中/小)はサロンボード連携+HPBサロンページから自動検出した
// 値をそのまま使うため、選択UI・カスケード取得は無い(#salon-auto-field/#area-auto-field
// のdata属性で「未取得かどうか」だけを使う画面もある)。
// - 対策キーワード設定(新規): キーワードを1個ずつ入力→「追加」で即座にAJAX保存し、
//   登録済み一覧にそのままチップとして反映する(#keyword-chips, #keyword-hidden-containerなし)
// - 対策キーワード編集: フォーム送信方式のタグ入力(ローカル状態→「保存」でまとめて送信、
//   #keyword-hidden-containerあり)
// - 「測定」ボタン(登録済みキーワードを中/小エリアでバックグラウンド測定) … 順位測定

;(function () {
  var KEYWORD_MAX = 20

  // ------------------------------------------------
  // 対策キーワード編集画面: フォーム送信方式のタグ入力
  // ------------------------------------------------
  var keywordHiddenContainer = document.getElementById('keyword-hidden-container')
  if (keywordHiddenContainer) {
    var editInput = document.getElementById('keyword-input')
    var editAddBtn = document.getElementById('keyword-add-btn')
    var editChips = document.getElementById('keyword-chips')
    var editCountEl = document.getElementById('keyword-count')
    var editKeywords = Array.from(keywordHiddenContainer.querySelectorAll('.keyword-hidden-input')).map(function (el) {
      return el.value
    })

    var renderEditKeywords = function () {
      editChips.innerHTML = ''
      editKeywords.forEach(function (kw, i) {
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
          editKeywords.splice(i, 1)
          renderEditKeywords()
        })
        chip.appendChild(removeBtn)
        editChips.appendChild(chip)
      })

      keywordHiddenContainer.innerHTML = ''
      editKeywords.forEach(function (kw, i) {
        var hidden = document.createElement('input')
        hidden.type = 'hidden'
        hidden.name = 'keyword_' + i
        hidden.value = kw
        keywordHiddenContainer.appendChild(hidden)
      })

      if (editCountEl) editCountEl.textContent = editKeywords.length
      var atMax = editKeywords.length >= KEYWORD_MAX
      if (editAddBtn) editAddBtn.disabled = atMax
      if (editInput) editInput.disabled = atMax
    }

    var addEditKeyword = function () {
      if (!editInput) return
      var v = editInput.value.trim()
      if (!v || editKeywords.length >= KEYWORD_MAX) return
      if (editKeywords.indexOf(v) === -1) editKeywords.push(v)
      editInput.value = ''
      renderEditKeywords()
      editInput.focus()
    }

    if (editAddBtn) editAddBtn.addEventListener('click', addEditKeyword)
    if (editInput) {
      editInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault()
          addEditKeyword()
        }
      })
    }
    renderEditKeywords()
  }

  // ------------------------------------------------
  // 対策キーワード設定画面(新規): 1個ずつAJAXで追加/削除する即時保存モード
  // ------------------------------------------------
  var ajaxChips = document.getElementById('keyword-chips')
  if (ajaxChips && !keywordHiddenContainer) {
    var kwInput = document.getElementById('keyword-input')
    var kwAddBtn = document.getElementById('keyword-add-btn')
    var kwCountEl = document.getElementById('keyword-count')
    var kwStatusEl = document.getElementById('keyword-add-status')

    var chipCount = function () {
      return ajaxChips.querySelectorAll('.keyword-chip').length
    }

    var updateAjaxState = function () {
      var n = chipCount()
      if (kwCountEl) kwCountEl.textContent = n
      var atMax = n >= KEYWORD_MAX
      if (kwAddBtn) kwAddBtn.disabled = atMax
      if (kwInput) kwInput.disabled = atMax
    }

    var makeChip = function (id, keyword) {
      var chip = document.createElement('span')
      chip.className =
        'keyword-chip inline-flex items-center gap-1.5 bg-pink-50 text-pink-700 border border-pink-200 rounded-full pl-3 pr-2 py-1 text-sm'
      chip.setAttribute('data-id', id)
      var text = document.createElement('span')
      text.textContent = keyword
      chip.appendChild(text)
      var removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'keyword-remove-btn text-pink-400 hover:text-pink-600 leading-none'
      removeBtn.setAttribute('data-id', id)
      removeBtn.textContent = '×'
      chip.appendChild(removeBtn)
      return chip
    }

    ajaxChips.addEventListener('click', async function (e) {
      var btn = e.target.closest && e.target.closest('.keyword-remove-btn')
      if (!btn) return
      var chip = btn.closest('.keyword-chip')
      var id = btn.getAttribute('data-id')
      if (!chip || !id) return
      chip.remove()
      var emptyEl = document.getElementById('keyword-empty')
      if (chipCount() === 0 && !emptyEl) {
        emptyEl = document.createElement('p')
        emptyEl.id = 'keyword-empty'
        emptyEl.className = 'text-sm text-gray-400'
        emptyEl.textContent = 'まだ登録がありません。上の入力欄からキーワードを追加してください。'
        ajaxChips.appendChild(emptyEl)
      }
      updateAjaxState()
      try {
        await fetch('/api/seo/keywords/' + id + '/delete', { method: 'POST' })
      } catch (err) {
        // 失敗しても画面上は削除済みのまま(再読み込みで復元される)
      }
    })

    var addAjaxKeyword = async function () {
      if (!kwInput) return
      var v = kwInput.value.trim()
      if (!v || chipCount() >= KEYWORD_MAX) return
      if (kwStatusEl) kwStatusEl.textContent = ''
      var prevCount = chipCount()
      kwInput.disabled = true
      if (kwAddBtn) kwAddBtn.disabled = true
      try {
        var res = await fetch('/api/seo/keywords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyword: v })
        })
        var data = await res.json()
        if (data.success) {
          if (data.keywords.length > prevCount) {
            var emptyEl = document.getElementById('keyword-empty')
            if (emptyEl) emptyEl.remove()
            var newest = data.keywords[data.keywords.length - 1]
            ajaxChips.appendChild(makeChip(newest.id, newest.keyword))
            kwInput.value = ''
          } else if (kwStatusEl) {
            kwStatusEl.textContent = 'このキーワードは既に登録されています'
          }
          updateAjaxState()
        } else if (kwStatusEl) {
          kwStatusEl.textContent = data.error || '追加に失敗しました'
        }
      } catch (err) {
        if (kwStatusEl) kwStatusEl.textContent = '通信エラーが発生しました'
      } finally {
        var atMax = chipCount() >= KEYWORD_MAX
        kwInput.disabled = atMax
        if (kwAddBtn) kwAddBtn.disabled = atMax
        kwInput.focus()
      }
    }

    if (kwAddBtn) kwAddBtn.addEventListener('click', addAjaxKeyword)
    if (kwInput) {
      kwInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault()
          addAjaxKeyword()
        }
      })
    }
    updateAjaxState()
  }

  // 「測定」ボタン(順位測定ページ: 登録済みの対策キーワードを中/小エリアで測定)
  var status = document.getElementById('measure-status')
  var measureRunBtn = document.getElementById('measure-run-btn')
  if (measureRunBtn) {
    measureRunBtn.addEventListener('click', async function () {
      measureRunBtn.disabled = true
      if (status) status.textContent = '測定を開始しています...'
      if (window.SalonSyncModal) window.SalonSyncModal.show('順位測定を開始しています...')
      try {
        var res = await fetch('/seo/measure', { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          if (status)
            status.textContent = '測定を開始しました。完了まで少し時間がかかります。まもなく自動更新します...'
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
      } finally {
        if (window.SalonSyncModal) window.SalonSyncModal.hide()
      }
    })
  }
})()
