// スタイル画像ライブラリ画面の操作用JS
document.addEventListener('DOMContentLoaded', () => {
  const selectedCountEl = document.getElementById('selected-count')

  function updateSelectedCount(count) {
    if (selectedCountEl) selectedCountEl.textContent = count
  }

  function applyAutoPostRowState(row, selected) {
    if (!row) return
    row.setAttribute('data-auto-post', selected ? '1' : '0')
    const badge = row.querySelector('.auto-post-badge')
    if (badge) {
      badge.textContent = selected ? '自動投稿ON' : '自動投稿OFF'
      badge.classList.toggle('bg-blue-50', selected)
      badge.classList.toggle('text-blue-600', selected)
      badge.classList.toggle('bg-gray-100', !selected)
      badge.classList.toggle('text-gray-400', !selected)
    }
  }

  // チェックボックスの切り替え
  document.querySelectorAll('.style-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const target = e.target
      const imageId = Number(target.getAttribute('data-image-id'))
      const selected = target.checked

      try {
        const res = await fetch('/api/style/toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageId, selected })
        })
        const data = await res.json()
        updateSelectedCount(data.selectedCount)
        applyAutoPostRowState(target.closest('[data-image-id][data-auto-post]'), selected)
      } catch (err) {
        alert('更新に失敗しました。再度お試しください。')
        target.checked = !selected
      }
    })
  })

  // 登録済みスタイルの全選択/全解除
  async function toggleAllStyles(selected) {
    const confirmMessage = selected
      ? '全てのスタイルを自動投稿対象(ON)にします。よろしいですか？'
      : '全てのスタイルの自動投稿対象を解除(OFF)します。よろしいですか？'
    if (!confirm(confirmMessage)) return
    try {
      const res = await fetch('/api/style/toggle-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selected })
      })
      const data = await res.json()
      if (!data.success) {
        alert('更新に失敗しました。再度お試しください。')
        return
      }
      updateSelectedCount(data.selectedCount)
      document.querySelectorAll('.style-checkbox').forEach((checkbox) => {
        checkbox.checked = selected
        applyAutoPostRowState(checkbox.closest('[data-image-id][data-auto-post]'), selected)
      })
    } catch (err) {
      alert('通信エラーが発生しました')
    }
  }
  const styleSelectAllBtn = document.getElementById('style-select-all-btn')
  if (styleSelectAllBtn) {
    styleSelectAllBtn.addEventListener('click', () => toggleAllStyles(true))
  }
  const styleDeselectAllBtn = document.getElementById('style-deselect-all-btn')
  if (styleDeselectAllBtn) {
    styleDeselectAllBtn.addEventListener('click', () => toggleAllStyles(false))
  }

  // ON/OFF表示切り替え
  const styleFilterSelect = document.getElementById('style-filter-select')
  if (styleFilterSelect) {
    styleFilterSelect.addEventListener('change', () => {
      const filter = styleFilterSelect.value
      document.querySelectorAll('#style-list > [data-auto-post]').forEach((row) => {
        const on = row.getAttribute('data-auto-post') === '1'
        const show = filter === 'all' || (filter === 'on' && on) || (filter === 'off' && !on)
        row.classList.toggle('hidden', !show)
      })
    })
  }

  // テンプレート反映対象の選択(自動投稿対象=auto_post_enabled_flagとは別物、
  // DBには保存しないページ内限定の一時的な選択。常に未選択から始まる)
  const templateTargetCountEl = document.getElementById('template-target-selected-count')
  function updateTemplateTargetCount() {
    if (templateTargetCountEl) {
      templateTargetCountEl.textContent = document.querySelectorAll('.template-target-checkbox:checked').length
    }
  }
  document.querySelectorAll('.template-target-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', updateTemplateTargetCount)
  })

  // 2026-08-22追記(ユーザー指定): テンプレート反映スタイルを100件ずつの
  // ページ表示にする(既存スタイル取り込み・HPBからブログ追加の一覧と同じ
  // 考え方)。全選択/全解除は表示中のページのみを対象にする。
  const templateTargetPaginationEl = document.getElementById('template-target-pagination')
  if (templateTargetPaginationEl) {
    var PAGE_SIZE = 100
    var rows = Array.prototype.slice.call(document.querySelectorAll('#style-list > [data-page]'))
    var totalPages = rows.reduce(function (max, row) {
      return Math.max(max, Number(row.getAttribute('data-page')) || 1)
    }, 1)
    var currentPage = 1

    var labelEl = document.getElementById('template-target-pagination-label')
    var prevBtn = document.getElementById('template-target-page-prev')
    var nextBtn = document.getElementById('template-target-page-next')

    function renderTemplateTargetPage() {
      var visibleCount = 0
      rows.forEach(function (row) {
        var isCurrent = Number(row.getAttribute('data-page')) === currentPage
        row.classList.toggle('hidden', !isCurrent)
        if (isCurrent) visibleCount += 1
      })
      if (totalPages > 1) {
        templateTargetPaginationEl.classList.remove('hidden')
        templateTargetPaginationEl.classList.add('flex')
        var start = (currentPage - 1) * PAGE_SIZE
        if (labelEl) {
          labelEl.textContent =
            (start + 1) + '〜' + (start + visibleCount) + '件 / 全' + rows.length + '件（' + currentPage + ' / ' + totalPages + 'ページ）'
        }
        if (prevBtn) prevBtn.disabled = currentPage <= 1
        if (nextBtn) nextBtn.disabled = currentPage >= totalPages
      } else {
        templateTargetPaginationEl.classList.add('hidden')
        templateTargetPaginationEl.classList.remove('flex')
      }
    }
    renderTemplateTargetPage()

    var styleListEl = document.getElementById('style-list')
    if (prevBtn) {
      prevBtn.addEventListener('click', function () {
        if (currentPage <= 1) return
        currentPage -= 1
        renderTemplateTargetPage()
        if (styleListEl) styleListEl.scrollIntoView({ block: 'start' })
      })
    }
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        if (currentPage >= totalPages) return
        currentPage += 1
        renderTemplateTargetPage()
        if (styleListEl) styleListEl.scrollIntoView({ block: 'start' })
      })
    }
  }

  const templateTargetSelectAllBtn = document.getElementById('template-target-select-all-btn')
  if (templateTargetSelectAllBtn) {
    templateTargetSelectAllBtn.addEventListener('click', () => {
      document.querySelectorAll('#style-list > [data-page]:not(.hidden) .template-target-checkbox').forEach((cb) => (cb.checked = true))
      updateTemplateTargetCount()
    })
  }
  const templateTargetDeselectAllBtn = document.getElementById('template-target-deselect-all-btn')
  if (templateTargetDeselectAllBtn) {
    templateTargetDeselectAllBtn.addEventListener('click', () => {
      document.querySelectorAll('#style-list > [data-page]:not(.hidden) .template-target-checkbox').forEach((cb) => (cb.checked = false))
      updateTemplateTargetCount()
    })
  }

  // No.欄の手入力による並び替え
  document.querySelectorAll('.style-order-input').forEach((input) => {
    input.addEventListener('change', async (e) => {
      const target = e.target
      const imageId = Number(target.getAttribute('data-image-id'))
      const newPosition = Number(target.value)
      if (!newPosition || newPosition < 1) {
        alert('1以上の数値を入力してください')
        location.reload()
        return
      }

      try {
        const res = await fetch('/api/style/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ styleId: imageId, newPosition })
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

  // 画像削除
  document.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const target = e.currentTarget
      const imageId = target.getAttribute('data-image-id')
      if (!confirm('この画像を削除しますか？')) return

      try {
        const res = await fetch(`/style/library/delete/${imageId}`, { method: 'POST' })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || !data.success) {
          alert('削除に失敗しました。')
          return
        }
        const card = document.querySelector(`[data-image-id="${imageId}"]`)
        if (card) card.remove()
        location.reload()
      } catch (err) {
        alert('削除に失敗しました。')
      }
    })
  })

  // テンプレート一括適用
  const bulkApplyBtn = document.getElementById('bulk-apply-btn')
  if (bulkApplyBtn) {
    bulkApplyBtn.addEventListener('click', async () => {
      const select = document.getElementById('bulk-apply-template-select')
      const templateId = Number(select.value)
      if (!templateId) {
        alert('テンプレートを選択してください')
        return
      }

      const styleIds = Array.from(document.querySelectorAll('.template-target-checkbox:checked')).map((cb) =>
        Number(cb.getAttribute('data-image-id'))
      )
      if (styleIds.length === 0) {
        alert('適用先のスタイルにチェックを入れてください')
        return
      }
      if (!confirm(`チェック中の${styleIds.length}件のスタイルにテンプレートを適用します。よろしいですか？`)) return

      bulkApplyBtn.disabled = true
      try {
        const res = await fetch('/api/style/bulk-apply-template', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templateId, styleIds })
        })
        const data = await res.json()
        if (data.success) {
          alert(`適用しました（${data.appliedCount} / ${data.totalCount}件）`)
        } else {
          alert('一部またはすべて失敗しました: ' + (data.errors || []).join(', '))
        }
        location.reload()
      } catch (err) {
        alert('通信エラーが発生しました')
        bulkApplyBtn.disabled = false
      }
    })
  }
})
