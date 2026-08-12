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
      } catch (err) {
        alert('更新に失敗しました。再度お試しください。')
        target.checked = !selected
      }
    })
  })

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
        await fetch(`/style/library/delete/${imageId}`, { method: 'POST' })
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

      const styleIds = Array.from(document.querySelectorAll('.style-checkbox:checked')).map((cb) =>
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
