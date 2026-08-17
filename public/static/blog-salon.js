// サロン基本情報ページ: サロンボード同期ボタン
document.addEventListener('DOMContentLoaded', () => {
  var btn = document.getElementById('blog-salon-sync-btn')
  var status = document.getElementById('blog-salon-sync-status')
  if (!btn) return

  btn.addEventListener('click', async function () {
    btn.disabled = true
    status.textContent = 'サロンボードから読み込み中...(数十秒かかることがあります)'
    try {
      var res = await fetch('/api/settings/sync-stylists-coupons', { method: 'POST' })
      var data = await res.json()
      if (data.success) {
        var syncRes = await fetch('/blog/salon/mark-synced', { method: 'POST' })
        var syncData = await syncRes.json()
        var msg = `完了しました(スタイリスト${data.stylistCount}件・クーポン${data.couponCount}件・ブログ記事${syncData.articleCount || 0}件を取得)`
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
      status.textContent = '通信エラーが発生しました'
    } finally {
      btn.disabled = false
    }
  })
})
