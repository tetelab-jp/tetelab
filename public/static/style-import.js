document.addEventListener('DOMContentLoaded', () => {
  const fetchBtn = document.getElementById('fetch-list-btn')
  const statusEl = document.getElementById('import-status')
  const listContainer = document.getElementById('import-list-container')
  const listEl = document.getElementById('import-list')
  const executeBtn = document.getElementById('import-execute-btn')

  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      fetchBtn.disabled = true
      statusEl.textContent = 'サロンボードから一覧を取得中...（数十秒かかる場合があります）'
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
        statusEl.textContent = data.styles.length + '件のスタイルが見つかりました'
        listEl.innerHTML = ''
        data.styles.forEach((s) => {
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
      } catch (e) {
        statusEl.textContent = '通信エラーが発生しました'
      } finally {
        fetchBtn.disabled = false
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
      statusEl.textContent = '取り込み中...（数十秒〜数分かかる場合があります）'
      try {
        const res = await fetch('/api/style/import/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ styleIds })
        })
        const data = await res.json()
        if (data.success) {
          statusEl.textContent = '完了: ' + data.importedCount + '件取り込みました'
          if (data.errors && data.errors.length > 0) {
            statusEl.textContent += '（一部失敗: ' + data.errors.join(', ') + '）'
          }
          setTimeout(() => {
            window.location.href = '/style/library'
          }, 2000)
        } else {
          statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
        }
      } catch (e) {
        statusEl.textContent = '通信エラーが発生しました'
      } finally {
        executeBtn.disabled = false
      }
    })
  }
})
