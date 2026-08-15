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

  // SALON BOARDへの自動投稿: 「今すぐ1本投稿する」ボタン
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
          if (status) status.textContent = '投稿処理を開始しました。完了まで数分かかります。'
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
  let currentAutoPostFilter = 'all'

  function applyFilters() {
    const categoryFilter = document.getElementById('blog-category-filter')?.value || ''
    articleList?.querySelectorAll(':scope > [data-auto-post]').forEach((row) => {
      const on = row.getAttribute('data-auto-post') === '1'
      const matchesAutoPost = currentAutoPostFilter === 'all' || (currentAutoPostFilter === 'on' && on) || (currentAutoPostFilter === 'off' && !on)
      const matchesCategory = !categoryFilter || row.getAttribute('data-category-id') === categoryFilter
      row.classList.toggle('hidden', !(matchesAutoPost && matchesCategory))
    })
  }

  document.querySelectorAll('.blog-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.blog-filter-btn').forEach((b) => {
        b.classList.toggle('bg-pink-500', b === btn)
        b.classList.toggle('text-white', b === btn)
        b.classList.toggle('text-gray-500', b !== btn)
      })
      currentAutoPostFilter = btn.getAttribute('data-filter')
      applyFilters()
    })
  })
  const initialBlogFilterBtn = document.querySelector('.blog-filter-btn[data-filter="all"]')
  if (initialBlogFilterBtn) initialBlogFilterBtn.classList.add('bg-pink-500', 'text-white')

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

  // 承認チェックの全選択/全解除(現在表示中の行のみを対象にする)
  const selectAllBtn = document.getElementById('blog-select-all-btn')
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', () => {
      articleList?.querySelectorAll(':scope > [data-auto-post]:not(.hidden) .blog-article-checkbox').forEach((cb) => {
        cb.checked = true
      })
      updateBulkBar()
    })
  }
  const deselectAllBtn = document.getElementById('blog-deselect-all-btn')
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.blog-article-checkbox').forEach((cb) => {
        cb.checked = false
      })
      updateBulkBar()
    })
  }

  // 自動投稿の一括ON/OFF(承認チェックの全選択/全解除とは別物。1件ずつサーバーへ
  // 反映する必要があるため、既存のchangeハンドラをdispatchEventで再利用する。
  // 現在表示中の行のみを対象にし、既に目的の状態のものは通信を発生させない)
  function bulkSetAutoPost(enabled) {
    articleList?.querySelectorAll(':scope > [data-auto-post]:not(.hidden) .blog-auto-post-toggle').forEach((cb) => {
      if (cb.checked !== enabled) {
        cb.checked = enabled
        cb.dispatchEvent(new Event('change'))
      }
    })
  }
  const autoPostSelectAllBtn = document.getElementById('blog-auto-post-select-all-btn')
  if (autoPostSelectAllBtn) {
    autoPostSelectAllBtn.addEventListener('click', () => bulkSetAutoPost(true))
  }
  const autoPostDeselectAllBtn = document.getElementById('blog-auto-post-deselect-all-btn')
  if (autoPostDeselectAllBtn) {
    autoPostDeselectAllBtn.addEventListener('click', () => bulkSetAutoPost(false))
  }

  // 一括操作バーの選択状態管理
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
  // (チェックボックス自体や、全選択/全解除ボタンのクリックはそれぞれの
  // ハンドラで既に処理されるため無視する)
  document.addEventListener('click', (e) => {
    if (!bulkBar || bulkBar.classList.contains('hidden')) return
    if (bulkBar.contains(e.target)) return
    if (e.target.closest('.blog-article-checkbox')) return
    if (e.target.closest('#blog-select-all-btn, #blog-deselect-all-btn')) return
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

  // ---------- 記事確認モーダル ----------
  const modal = document.getElementById('blog-reviewer')
  let currentArticleId = null
  let currentFooterLen = 0

  function openReviewer(articleId) {
    currentArticleId = articleId
    fetch(`/api/blog/articles/${articleId}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          alert('読み込みに失敗しました: ' + (data.error || '不明なエラー'))
          return
        }
        paintReviewer(data)
        modal.classList.remove('hidden')
        modal.classList.add('flex')
      })
      .catch(() => alert('通信エラーが発生しました'))
  }

  function paintReviewer(data) {
    const a = data.article
    document.getElementById('rv-no').textContent = a.id
    document.getElementById('rv-status').textContent = a.status
    document.getElementById('rv-image').src = `/blog/article/${a.id}/image`
    document.getElementById('rv-description').value = a.image_description || ''
    document.getElementById('rv-title').value = a.title || ''
    document.getElementById('rv-body').value = a.body || ''
    document.getElementById('rv-footer').textContent = data.footer || ''
    currentFooterLen = (data.footer || '').length

    const categorySelect = document.getElementById('rv-category')
    categorySelect.innerHTML = data.categories.map((c) => `<option value="${c.id}"${c.id === a.category_id ? ' selected' : ''}>${c.name}</option>`).join('')

    const stylistSelect = document.getElementById('rv-stylist')
    stylistSelect.innerHTML =
      '<option value="">未設定</option>' +
      data.stylists.map((s) => `<option value="${s.id}"${s.id === a.stylist_id ? ' selected' : ''}>${s.name}</option>`).join('')

    const couponSelect = document.getElementById('rv-coupon')
    couponSelect.innerHTML =
      '<option value="">未設定</option>' +
      data.coupons.map((c) => `<option value="${c.id}"${c.id === a.coupon_id ? ' selected' : ''}>${c.name}</option>`).join('')

    const monthTags = JSON.parse(a.month_tags_json || '[]')
    const monthTagsEl = document.getElementById('rv-month-tags')
    monthTagsEl.innerHTML = ''
    for (let m = 1; m <= 12; m++) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = m + '月'
      btn.className =
        'text-xs px-2 py-1 rounded ' + (monthTags.includes(m) ? 'bg-pink-500 text-white' : 'bg-gray-100 text-gray-500')
      btn.setAttribute('data-month', m)
      btn.addEventListener('click', () => {
        const active = btn.classList.contains('bg-pink-500')
        btn.classList.toggle('bg-pink-500', !active)
        btn.classList.toggle('text-white', !active)
        btn.classList.toggle('bg-gray-100', active)
        btn.classList.toggle('text-gray-500', active)
      })
      monthTagsEl.appendChild(btn)
    }

    const isApproved = a.status === 'approved'
    document.getElementById('rv-approve-btn').classList.toggle('hidden', isApproved)
    document.getElementById('rv-unapprove-btn').classList.toggle('hidden', !isApproved)
    ;['rv-title', 'rv-body', 'rv-description', 'rv-category', 'rv-stylist', 'rv-coupon'].forEach((id) => {
      document.getElementById(id).disabled = isApproved
    })
    document.getElementById('rv-save-btn').disabled = isApproved
    document.getElementById('rv-regen-body-btn').disabled = isApproved
    document.getElementById('rv-regen-description-btn').disabled = isApproved

    updateCounters()
  }

  function updateCounters() {
    const title = document.getElementById('rv-title').value
    const body = document.getElementById('rv-body').value
    document.getElementById('rv-title-len').textContent = title.length
    document.getElementById('rv-body-len').textContent = body.length + currentFooterLen
    document.getElementById('rv-body-lines').textContent = body.split('\n').length - 1
  }
  document.getElementById('rv-title').addEventListener('input', updateCounters)
  document.getElementById('rv-body').addEventListener('input', updateCounters)

  document.querySelectorAll('.blog-open-article-btn').forEach((btn) => {
    btn.addEventListener('click', () => openReviewer(Number(btn.getAttribute('data-article-id'))))
  })

  document.getElementById('rv-close-btn').addEventListener('click', () => {
    modal.classList.add('hidden')
    modal.classList.remove('flex')
  })

  function collectMonthTags() {
    return Array.from(document.querySelectorAll('#rv-month-tags button.bg-pink-500')).map((b) => Number(b.getAttribute('data-month')))
  }

  async function saveArticle() {
    const payload = {
      title: document.getElementById('rv-title').value,
      body: document.getElementById('rv-body').value,
      image_description: document.getElementById('rv-description').value,
      category_id: Number(document.getElementById('rv-category').value) || null,
      stylist_id: document.getElementById('rv-stylist').value ? Number(document.getElementById('rv-stylist').value) : null,
      coupon_id: document.getElementById('rv-coupon').value ? Number(document.getElementById('rv-coupon').value) : null,
      month_tags: collectMonthTags()
    }
    const res = await fetch(`/api/blog/articles/${currentArticleId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return res.json()
  }

  document.getElementById('rv-save-btn').addEventListener('click', async () => {
    const data = await saveArticle()
    if (!data.success) {
      alert('保存に失敗しました: ' + (data.error || '不明なエラー'))
    }
  })

  document.getElementById('rv-approve-btn').addEventListener('click', async () => {
    const saveResult = await saveArticle()
    if (!saveResult.success) {
      alert('保存に失敗しました: ' + (saveResult.error || '不明なエラー'))
      return
    }
    const res = await fetch(`/api/blog/articles/${currentArticleId}/approve`, { method: 'POST' })
    const data = await res.json()
    if (data.success) {
      location.reload()
    } else {
      alert('承認に失敗しました')
    }
  })

  document.getElementById('rv-unapprove-btn').addEventListener('click', async () => {
    await fetch(`/api/blog/articles/${currentArticleId}/unapprove`, { method: 'POST' })
    location.reload()
  })

  document.getElementById('rv-regen-description-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    try {
      const res = await fetch(`/api/blog/articles/${currentArticleId}/regenerate-description`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        document.getElementById('rv-description').value = data.description
      } else {
        alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
      }
    } catch (err) {
      alert('通信エラーが発生しました')
    } finally {
      btn.disabled = false
    }
  })

  document.getElementById('rv-regen-body-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    btn.disabled = true
    btn.textContent = '生成中...'
    try {
      const res = await fetch(`/api/blog/articles/${currentArticleId}/regenerate-body`, { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        document.getElementById('rv-title').value = data.title
        document.getElementById('rv-body').value = data.body
        updateCounters()
      } else {
        alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
      }
    } catch (err) {
      alert('通信エラーが発生しました')
    } finally {
      btn.disabled = false
      btn.textContent = '本文を再生成'
    }
  })
})
