document.getElementById('test-run-btn').addEventListener('click', async function () {
  var btn = this
  var status = document.getElementById('test-run-status')
  btn.disabled = true
  status.textContent = '実行中...（数十秒〜数分かかる場合があります）'
  try {
    var res = await fetch('/api/automation/test-run', { method: 'POST' })
    var data = await res.json()
    if (data.success) {
      status.textContent = '完了: 成功 ' + data.successCount + '件 / 失敗 ' + data.failureCount + '件'
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
