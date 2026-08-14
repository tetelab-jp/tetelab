// スタイル画像ライブラリ画面の操作用JS
document.addEventListener('DOMContentLoaded', () => {
  const selectedCountEl = document.getElementById('selected-count')

  function updateSelectedCount(count) {
    if (selectedCountEl) selectedCountEl.textContent = count
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
        const row = target.closest('[data-image-id][data-auto-post]')
        if (row) row.setAttribute('data-auto-post', selected ? '1' : '0')
      } catch (err) {
        alert('更新に失敗しました。再度お試しください。')
        target.checked = !selected
      }
    })
  })

  // ON/OFF表示切り替え
  document.querySelectorAll('.style-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.style-filter-btn').forEach((b) => {
        b.classList.toggle('bg-pink-500', b === btn)
        b.classList.toggle('text-white', b === btn)
        b.classList.toggle('text-gray-500', b !== btn)
      })
      const filter = btn.getAttribute('data-filter')
      document.querySelectorAll('#style-list > [data-auto-post]').forEach((row) => {
        const on = row.getAttribute('data-auto-post') === '1'
        const show = filter === 'all' || (filter === 'on' && on) || (filter === 'off' && !on)
        row.classList.toggle('hidden', !show)
      })
    })
  })
  const initialFilterBtn = document.querySelector('.style-filter-btn[data-filter="all"]')
  if (initialFilterBtn) {
    initialFilterBtn.classList.add('bg-pink-500', 'text-white')
  }

  // ドラッグハンドルによる並び替え(マウス・タッチ両対応、Pointer Events使用)
  function setupDragReorder(listId, handleClass, endpoint, idKey) {
    const list = document.getElementById(listId)
    if (!list) return
    list.querySelectorAll('.' + handleClass).forEach((handle) => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        const row = handle.closest('[data-image-id]')
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
          const id = Number(row.getAttribute('data-image-id'))
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
  setupDragReorder('style-list', 'style-drag-handle', '/api/style/reorder', 'styleId')

  // 全選択
  const selectAllBtn = document.getElementById('select-all-btn')
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/style/bulk-select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected: true })
        })
        const data = await res.json()
        document.querySelectorAll('.style-checkbox').forEach((cb) => (cb.checked = true))
        updateSelectedCount(data.selectedCount)
      } catch (err) {
        alert('更新に失敗しました。')
      }
    })
  }

  // 全解除
  const deselectAllBtn = document.getElementById('deselect-all-btn')
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/style/bulk-select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ selected: false })
        })
        const data = await res.json()
        document.querySelectorAll('.style-checkbox').forEach((cb) => (cb.checked = false))
        updateSelectedCount(data.selectedCount)
      } catch (err) {
        alert('更新に失敗しました。')
      }
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
  const templateTargetSelectAllBtn = document.getElementById('template-target-select-all-btn')
  if (templateTargetSelectAllBtn) {
    templateTargetSelectAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.template-target-checkbox').forEach((cb) => (cb.checked = true))
      updateTemplateTargetCount()
    })
  }
  const templateTargetDeselectAllBtn = document.getElementById('template-target-deselect-all-btn')
  if (templateTargetDeselectAllBtn) {
    templateTargetDeselectAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.template-target-checkbox').forEach((cb) => (cb.checked = false))
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
