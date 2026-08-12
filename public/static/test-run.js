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
        var remaining = (data.totalImages || 1) - data.dispatchedCount - (data.failedToDispatchCount || 0)
        status.textContent =
          '1件目を投入しました' + (data.failedToDispatchCount ? '（投入失敗 ' + data.failedToDispatchCount + '件）' : '') + '。' +
          (remaining > 0 ? '残り' + remaining + '件は前の投稿の完了を待って順番に投入されます。' : '') +
          '結果は完了次第、実行履歴に反映されます（数十秒〜数分かかります）。'
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
