// サロン情報ページ: サロンボード同期ボタン(HPBからブログ追加ページと同じ
// サロンボード同期+mark-synced呼び出しを、このページからも直接行えるようにする)
document.addEventListener('DOMContentLoaded', () => {
  var btn = document.getElementById('salon-info-sync-btn')
  var status = document.getElementById('salon-info-sync-status')
  if (!btn) return

  btn.addEventListener('click', async function () {
    btn.disabled = true
    status.textContent = 'サロンボードから読み込み中...(数十秒かかることがあります)'
    var abortController = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (window.SalonSyncModal) {
      window.SalonSyncModal.show('サロンボードから情報を取得しています...', function () {
        if (abortController) abortController.abort()
      })
    }
    try {
      var signal = abortController ? abortController.signal : undefined
      var res = await fetch('/api/settings/sync-stylists-coupons', { method: 'POST', signal: signal })
      var data = await res.json()
      if (data.success) {
        var syncRes = await fetch('/blog/salon/mark-synced', { method: 'POST', signal: signal })
        var syncData = await syncRes.json()
        var msg = '完了しました(スタイリスト' + data.stylistCount + '件・クーポン' + data.couponCount + '件を取得)'
        if (syncData.hpbError) {
          msg += ' / ' + syncData.hpbError
        }
        status.textContent = msg
        setTimeout(function () {
          location.reload()
        }, 800)
      } else {
        status.textContent = 'エラー: ' + (data.error || '不明なエラー')
      }
    } catch (e) {
      status.textContent = e && e.name === 'AbortError' ? 'キャンセルしました' : '通信エラーが発生しました'
    } finally {
      if (window.SalonSyncModal) window.SalonSyncModal.hide()
      btn.disabled = false
    }
  })
})
