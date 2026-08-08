document.getElementById('test-run-btn').addEventListener('click', async function () {
  var btn = this
  var status = document.getElementById('test-run-status')
  btn.disabled = true
  status.textContent = '実行中...（数十秒〜数分かかる場合があります）'
  try {
    var res = await fetch('/api/automation/test-run', { method: 'POST' })
    var data = await res.json()
    if (data.success || (data.status && data.status !== 'failed')) {
      status.textContent =
        '完了: 成功 ' + data.successCount + '件 / 失敗 ' + data.failureCount + '件 / ブロック ' + (data.blockedCount || 0) + '件'
    } else {
      status.textContent = 'エラー: ' + (data.error || '不明なエラー')
    }
  } catch (e) {
    status.textContent = '通信エラーが発生しました'
  } finally {
    btn.disabled = false
    setTimeout(function () {
      location.reload()
    }, 1500)
  }
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
        alert('再実行が成功しました')
      } else {
        alert('再実行結果: ' + (data.outcome || data.error || '失敗'))
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
