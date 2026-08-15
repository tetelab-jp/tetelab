var testRunBtn = document.getElementById('test-run-btn')
if (testRunBtn) {
  testRunBtn.addEventListener('click', async function () {
    var btn = this
    var status = document.getElementById('test-run-status')
    btn.disabled = true
    status.textContent = 'AWSへジョブを投入中...'
    try {
      var res = await fetch('/api/automation/test-run', { method: 'POST' })
      var data = await res.json()
      if (data.success) {
        status.textContent =
          (data.totalImages || 1) + 'スタイルを投稿します。投稿は自動で進むので待つ必要はありません。'
      } else {
        status.textContent = 'エラー: ' + (data.error || '不明なエラー')
      }
    } catch (e) {
      status.textContent = '通信エラーが発生しました'
    } finally {
      btn.disabled = false
    }
  })
}

// 実行日時・カテゴリ列をドラッグで横に広げられるようにする(Pointer Events使用)
;(function setupLogColumnResize() {
  document.querySelectorAll('.log-col-resize-handle').forEach(function (handle) {
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault()
      var col = document.getElementById(handle.getAttribute('data-target-col'))
      var th = handle.closest('th')
      if (!col || !th) return
      var startX = e.clientX
      var startWidth = th.offsetWidth
      handle.setPointerCapture(e.pointerId)

      function onMove(moveEvent) {
        var newWidth = Math.max(50, startWidth + (moveEvent.clientX - startX))
        col.style.width = newWidth + 'px'
      }
      function onUp(upEvent) {
        handle.releasePointerCapture(upEvent.pointerId)
        document.removeEventListener('pointermove', onMove)
        document.removeEventListener('pointerup', onUp)
      }
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    })
  })
})()

// 実行履歴のスタイル/ブログタブ切り替え
document.querySelectorAll('.log-tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var tab = btn.getAttribute('data-tab')
    document.querySelectorAll('.log-tab-btn').forEach(function (b) {
      var active = b === btn
      b.classList.toggle('border-pink-500', active)
      b.classList.toggle('text-pink-600', active)
      b.classList.toggle('border-transparent', !active)
      b.classList.toggle('text-gray-400', !active)
    })
    document.querySelectorAll('[data-tab-panel]').forEach(function (panel) {
      panel.classList.toggle('hidden', panel.getAttribute('data-tab-panel') !== tab)
    })
  })
})

document.querySelectorAll('.retry-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    var styleId = btn.getAttribute('data-style-id')
    btn.disabled = true
    var originalText = btn.textContent
    btn.textContent = '実行中...'
    try {
      var res = await fetch('/api/style/' + styleId + '/retry', { method: 'POST' })
      var data = await res.json()
      if (data.success) {
        alert('ジョブを投入しました。結果は完了次第、実行履歴に反映されます。')
      } else {
        alert('ジョブ投入に失敗しました: ' + (data.outcome || data.error || '失敗'))
      }
    } catch (e) {
      alert('通信エラーが発生しました')
    } finally {
      btn.disabled = false
      btn.textContent = originalText
      location.reload()
    }
  })
})

document.querySelectorAll('.delete-retry-target-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    if (!confirm('このスタイルを削除しますか？(登録画像も削除されます)')) return
    var styleId = btn.getAttribute('data-style-id')
    btn.disabled = true
    try {
      var res = await fetch('/style/library/delete/' + styleId, { method: 'POST' })
      var data = await res.json()
      if (!data.success) {
        alert('削除に失敗しました: ' + (data.error || '不明なエラー'))
        btn.disabled = false
        return
      }
    } catch (e) {
      alert('通信エラーが発生しました')
      btn.disabled = false
      return
    }
    location.reload()
  })
})
