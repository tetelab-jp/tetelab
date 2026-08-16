// 投稿記事一覧ページの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  // タブ切り替え(一覧/投稿カレンダー)
  document.querySelectorAll('.blog-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab')
      document.querySelectorAll('.blog-tab-btn').forEach((b) => {
        const active = b === btn
        b.classList.toggle('border-pink-500', active)
        b.classList.toggle('text-pink-600', active)
        b.classList.toggle('border-transparent', !active)
        b.classList.toggle('text-gray-400', !active)
      })
      document.querySelectorAll('[data-tab-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== tab)
      })
    })
  })

  // SALON BOARDへの自動投稿: 「今すぐまとめて投稿する」ボタン
  const blogTestRunBtn = document.getElementById('blog-test-run-btn')
  if (blogTestRunBtn) {
    blogTestRunBtn.addEventListener('click', async () => {
      const status = document.getElementById('blog-test-run-status')
      blogTestRunBtn.disabled = true
      if (status) status.textContent = '投稿処理を開始しています...'
      try {
        const res = await fetch('/api/blog-automation/test-run', { method: 'POST' })
        const data = await res.json()
        if (data.success) {
          if (status) {
            status.textContent =
              (data.totalArticles || 1) + '件のブログ記事を投稿します。投稿は自動で進むので待つ必要はありません。'
          }
        } else {
          if (status) status.textContent = 'エラー: ' + (data.error || '不明なエラー')
          blogTestRunBtn.disabled = false
        }
      } catch (e) {
        if (status) status.textContent = '通信エラーが発生しました'
        blogTestRunBtn.disabled = false
      }
    })
  }

  // 自動投稿ON/OFFトグル
  document.querySelectorAll('.blog-auto-post-toggle').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const target = e.target
      const articleId = Number(target.getAttribute('data-article-id'))
      const enabled = target.checked
      try {
        const res = await fetch('/api/blog/articles/toggle-auto-post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ articleId, enabled })
        })
        const data = await res.json()
        if (!data.success) throw new Error(data.error || '不明なエラー')
        const row = target.closest('[data-article-id][data-auto-post]')
        if (row) row.setAttribute('data-auto-post', enabled ? '1' : '0')
      } catch (err) {
        alert('更新に失敗しました。再度お試しください。')
        target.checked = !enabled
      }
    })
  })

  // ON/OFF・記事カテゴリの表示フィルター(組み合わせて適用する)
  const articleList = document.getElementById('blog-article-list')

  function applyFilters() {
    const autoPostFilter = document.getElementById('blog-filter-select')?.value || 'all'
    const categoryFilter = document.getElementById('blog-category-filter')?.value || ''
    articleList?.querySelectorAll(':scope > [data-auto-post]').forEach((row) => {
      const on = row.getAttribute('data-auto-post') === '1'
      const matchesAutoPost = autoPostFilter === 'all' || (autoPostFilter === 'on' && on) || (autoPostFilter === 'off' && !on)
      const matchesCategory = !categoryFilter || row.getAttribute('data-category-id') === categoryFilter
      row.classList.toggle('hidden', !(matchesAutoPost && matchesCategory))
    })
  }

  const filterSelect = document.getElementById('blog-filter-select')
  if (filterSelect) filterSelect.addEventListener('change', applyFilters)
  const categoryFilterSelect = document.getElementById('blog-category-filter')
  if (categoryFilterSelect) categoryFilterSelect.addEventListener('change', applyFilters)

  // 季節柄でのソート(表示上の並び替えのみ、生成順=sort_orderは変更しない)
  const sortSelect = document.getElementById('blog-sort-select')
  if (sortSelect && articleList) {
    const originalOrder = Array.from(articleList.children)
    sortSelect.addEventListener('change', () => {
      if (sortSelect.value === 'season') {
        const rows = Array.from(articleList.children)
        rows.sort((a, b) => {
          const minMonth = (row) => {
            const tags = JSON.parse(row.getAttribute('data-month-tags') || '[]')
            return tags.length > 0 ? Math.min(...tags) : 13
          }
          return minMonth(a) - minMonth(b)
        })
        rows.forEach((row) => articleList.appendChild(row))
      } else {
        originalOrder.forEach((row) => articleList.appendChild(row))
      }
    })
  }

  // ドラッグハンドルによる並べ替え(マウス・タッチ両対応、Pointer Events使用。
  // style-library.jsのsetupDragReorderと同じ方式)
  function setupDragReorder(listId, handleClass, endpoint, idKey) {
    const list = document.getElementById(listId)
    if (!list) return
    list.querySelectorAll('.' + handleClass).forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        const row = handle.closest('[data-article-id]')
        if (!row) return
        row.setPointerCapture(e.pointerId)
        row.classList.add('opacity-50')

        const onMove = (moveEvent) => {
          const rows = Array.from(list.children).filter((el) => !el.classList.contains('hidden') || el === row)
          const y = moveEvent.clientY
          for (const other of rows) {
            if (other === row) continue
            const rect = other.getBoundingClientRect()
            const mid = rect.top + rect.height / 2
            if (y < mid) {
              list.insertBefore(row, other)
              break
            } else if (!other.nextElementSibling || other === rows[rows.length - 1]) {
              list.insertBefore(row, other.nextElementSibling)
              break
            }
          }
        }

        const onUp = async (upEvent) => {
          row.releasePointerCapture(upEvent.pointerId)
          row.classList.remove('opacity-50')
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)

          const rows = Array.from(list.children)
          const newIndex = rows.indexOf(row)
          const id = Number(row.getAttribute('data-article-id'))
          try {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ [idKey]: id, newPosition: newIndex + 1 })
            })
            const data = await res.json()
            if (!data.success) alert('順番の変更に失敗しました: ' + (data.error || '不明なエラー'))
          } catch (err) {
            alert('通信エラーが発生しました')
          } finally {
            location.reload()
          }
        }

        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
      })
    })
  }
  setupDragReorder('blog-article-list', 'blog-drag-handle', '/api/blog/articles/reorder', 'articleId')

  // No.欄の手入力による並べ替え
  document.querySelectorAll('.blog-order-input').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const target = e.target
      const articleId = Number(target.getAttribute('data-article-id'))
      const newPosition = Number(target.value)
      if (!newPosition || newPosition < 1) {
        alert('1以上の数値を入力してください')
        location.reload()
        return
      }
      try {
        const res = await fetch('/api/blog/articles/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ articleId, newPosition })
        })
        const data = await res.json()
        if (!data.success) alert('順番の変更に失敗しました: ' + (data.error || '不明なエラー'))
      } catch (err) {
        alert('通信エラーが発生しました')
      } finally {
        location.reload()
      }
    })
  })

  // 記事削除
  document.querySelectorAll('.blog-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget
      const articleId = target.getAttribute('data-article-id')
      if (!confirm('この記事を削除しますか？(登録画像も削除されます)')) return
      try {
        const res = await fetch(`/blog/articles/${articleId}/delete`, { method: 'POST' })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || !data.success) {
          alert('削除に失敗しました。')
          return
        }
        location.reload()
      } catch (err) {
        alert('削除に失敗しました。')
      }
    })
  })

  // 一括操作バー(承認チェックを個別に付けた記事のみ対象)
  const bulkBar = document.getElementById('blog-bulk-bar')
  const selectedCountEl = document.getElementById('blog-selected-count')
  function selectedIds() {
    return Array.from(document.querySelectorAll('.blog-article-checkbox:checked')).map((cb) => Number(cb.getAttribute('data-article-id')))
  }
  function updateBulkBar() {
    const ids = selectedIds()
    if (selectedCountEl) selectedCountEl.textContent = ids.length
    if (bulkBar) bulkBar.classList.toggle('hidden', ids.length === 0)
  }
  document.querySelectorAll('.blog-article-checkbox').forEach((cb) => cb.addEventListener('change', updateBulkBar))

  // まとめて承認バーの外側をタップ/クリックしたら選択を解除して閉じる
  document.addEventListener('click', (e) => {
    if (!bulkBar || bulkBar.classList.contains('hidden')) return
    if (bulkBar.contains(e.target)) return
    if (e.target.closest('.blog-article-checkbox')) return
    document.querySelectorAll('.blog-article-checkbox:checked').forEach((cb) => {
      cb.checked = false
    })
    updateBulkBar()
  })

  const bulkApproveBtn = document.getElementById('blog-bulk-approve-btn')
  if (bulkApproveBtn) {
    bulkApproveBtn.addEventListener('click', async () => {
      const ids = selectedIds()
      if (ids.length === 0) return
      bulkApproveBtn.disabled = true
      try {
        const res = await fetch('/api/blog/articles/bulk-approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ articleIds: ids })
        })
        const data = await res.json()
        alert(`${data.count}件を承認しました`)
        location.reload()
      } catch (e) {
        alert('通信エラーが発生しました')
        bulkApproveBtn.disabled = false
      }
    })
  }

  const bulkCouponBtn = document.getElementById('blog-bulk-coupon-btn')
  if (bulkCouponBtn) {
    bulkCouponBtn.addEventListener('click', async () => {
      const ids = selectedIds()
      const select = document.getElementById('blog-bulk-coupon-select')
      if (ids.length === 0) return
      bulkCouponBtn.disabled = true
      try {
        await fetch('/api/blog/articles/bulk-set-coupon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ articleIds: ids, couponId: select.value ? Number(select.value) : null })
        })
        location.reload()
      } catch (e) {
        alert('通信エラーが発生しました')
        bulkCouponBtn.disabled = false
      }
    })
  }
})
