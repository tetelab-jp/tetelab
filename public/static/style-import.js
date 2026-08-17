document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('fetch-list-btn')
  const fetchBtnLabel = document.getElementById('fetch-list-btn-label')
  const statusEl = document.getElementById('import-status')
  const listContainer = document.getElementById('import-list-container')
  const listEl = document.getElementById('import-list')
  const executeBtn = document.getElementById('import-execute-btn')
  const executeBtnLabel = document.getElementById('import-execute-btn-label')
  const executeStatusEl = document.getElementById('import-execute-status')

  // 2026-08-13追記(ユーザー指定): 取得した一覧はこれまでサーバーに保存されず、
  // ページを離れると消えて再取得(サロンボードへの再ログイン・再取得)が
  // 必要になっていた。ユーザーの端末内(localStorage)に24時間だけキャッシュし、
  // 再訪問時は自動的に復元表示する(再取得ボタンはそのまま使え、押せば
  // いつでも最新化できる)。キャッシュ表示時はサロンボードへ再アクセスしない
  // ため、通信量もむしろ減る。
  // 2026-08-17追記(至急・重大バグ修正): CACHE_KEYが固定文字列だったため、
  // 同じブラウザ(同じlocalStorage)を複数のSalonMotionアカウントで使い回すと
  // (代理店・複数店舗管理などで同一端末から別アカウントに切り替える場合)、
  // 別アカウントが取得した取り込み候補一覧が最大24時間そのまま表示されて
  // しまう不具合があった(ユーザー報告により発覚)。ログイン中のユーザーID・
  // サロンIDをキーに含めることでアカウントごとにキャッシュを分離する。
  const OLD_UNSCOPED_CACHE_KEY = 'salonmotion_style_import_cache'
  try {
    localStorage.removeItem(OLD_UNSCOPED_CACHE_KEY)
  } catch (e) {}
  const cacheScope = listContainer ? listContainer.dataset.cacheScope || 'unknown' : 'unknown'
  const CACHE_KEY = 'salonmotion_style_import_cache_v2_' + cacheScope
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000

  function renderList(styles) {
    statusEl.textContent = styles.length + '件のスタイルが見つかりました'
    listEl.innerHTML = ''
    styles.forEach((s) => {
      const li = document.createElement('li')
      li.className = 'flex items-center gap-3 py-2'

      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'import-checkbox w-4 h-4 accent-pink-500 cursor-pointer flex-shrink-0'
      cb.value = s.styleId

      const noEl = document.createElement('span')
      noEl.className = 'w-8 text-center text-xs font-semibold text-gray-400 flex-shrink-0'
      noEl.textContent = s.sortNo || '-'

      const thumbWrap = document.createElement('div')
      thumbWrap.className = 'w-10 h-14 flex-shrink-0 bg-gray-50 rounded border border-gray-200 flex items-center justify-center overflow-hidden'
      if (s.imageUrl) {
        const img = document.createElement('img')
        img.src = s.imageUrl
        img.className = 'w-full h-full object-contain'
        img.loading = 'lazy'
        thumbWrap.appendChild(img)
      } else {
        const icon = document.createElement('i')
        icon.className = 'fas fa-image text-gray-300 text-sm'
        thumbWrap.appendChild(icon)
      }

      const label = document.createElement('label')
      label.className = 'flex items-center gap-3 cursor-pointer flex-1 min-w-0'
      const textWrap = document.createElement('div')
      textWrap.className = 'min-w-0'
      const nameEl = document.createElement('p')
      nameEl.className = 'truncate font-medium text-gray-700'
      nameEl.textContent = s.title || '（無題）'
      const stylistEl = document.createElement('p')
      stylistEl.className = 'text-xs text-gray-400'
      stylistEl.textContent = s.stylistName || '担当未設定'
      textWrap.appendChild(nameEl)
      textWrap.appendChild(stylistEl)
      label.appendChild(cb)
      label.appendChild(thumbWrap)
      label.appendChild(textWrap)

      li.appendChild(noEl)
      li.appendChild(label)
      listEl.appendChild(li)
    })
    listContainer.classList.remove('hidden')
  }

  function saveCache(styles) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ styles, fetchedAt: Date.now() }))
    } catch (e) {}
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.styles) || typeof parsed.fetchedAt !== 'number') return null
      if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null
      return parsed
    } catch (e) {
      return null
    }
  }

  const cached = loadCache()
  if (cached && cached.styles.length > 0) {
    renderList(cached.styles)
    const minutesAgo = Math.floor((Date.now() - cached.fetchedAt) / 60000)
    statusEl.textContent =
      cached.styles.length + '件のスタイル（' + minutesAgo + '分前に取得したもの）を表示しています。最新の状態にするには再取得してください。'
  }

  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true
      if (fetchBtnLabel) fetchBtnLabel.textContent = '取得中'
      statusEl.textContent = 'サロンボードからデータを取得中\n少しお待ちください'
      try {
        const res = await fetch('/api/style/import/fetch-list', { method: 'POST' })
        const data = await res.json()
        if (!data.success) {
          statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
          return
        }
        if (!data.styles || data.styles.length === 0) {
          statusEl.textContent = '取り込み可能なスタイルが見つかりませんでした'
          return
        }
        renderList(data.styles)
        saveCache(data.styles)
      } catch (e) {
        statusEl.textContent = '通信エラーが発生しました'
      } finally {
        fetchBtn.disabled = false
        if (fetchBtnLabel) fetchBtnLabel.textContent = 'サロンボードからスタイル取得'
      }
    })
  }

  if (executeBtn) {
    executeBtn.addEventListener('click', async () => {
      const styleIds = Array.from(document.querySelectorAll('.import-checkbox:checked')).map((cb) => cb.value)
      if (styleIds.length === 0) {
        alert('取り込むスタイルを選択してください')
        return
      }
      if (!confirm(styleIds.length + '件のスタイルを取り込みます。よろしいですか？')) return

      executeBtn.disabled = true
      if (executeBtnLabel) executeBtnLabel.textContent = '反映中'
      if (executeStatusEl) executeStatusEl.textContent = '反映までこのままで少し待ち下さい'
      try {
        const res = await fetch('/api/style/import/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ styleIds })
        })
        const data = await res.json()
        if (data.success) {
          if (data.errors && data.errors.length > 0) {
            if (executeStatusEl) {
              executeStatusEl.textContent =
                '完了: ' + data.importedCount + '件取り込みました（一部失敗: ' + data.errors.join(', ') + '）'
            }
          } else if (executeStatusEl) {
            executeStatusEl.textContent = '登録スタイルページをご確認ください'
          }
          // 2026-08-13追記(重大バグ修正): 成功時はこの後リダイレクトするだけなので、
          // ボタンを再度有効化してしまうと5秒の待機中に連打され重複した取り込み
          // リクエストが送られてしまっていた。成功時はボタンを無効なままにする。
          setTimeout(() => {
            window.location.href = '/style/library'
          }, 5000)
          return
        } else if (executeStatusEl) {
          executeStatusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
        }
      } catch (e) {
        if (executeStatusEl) executeStatusEl.textContent = '通信エラーが発生しました'
      }
      executeBtn.disabled = false
      if (executeBtnLabel) executeBtnLabel.textContent = '選択したスタイルを取り込む'
    })
  }
})
