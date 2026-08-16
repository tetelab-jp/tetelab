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

})
