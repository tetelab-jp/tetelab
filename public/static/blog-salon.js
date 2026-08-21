// サロン基本情報ページ: サロンボード同期ボタン
document.addEventListener('DOMContentLoaded', () => {
  var btn = document.getElementById('blog-salon-sync-btn')
  var status = document.getElementById('blog-salon-sync-status')
  if (!btn) return

  btn.addEventListener('click', async function () {
    btn.disabled = true
    status.textContent = 'サロンボードから読み込み中...(数十秒かかることがあります)'
    // 2026-08-22追記(ユーザー指定): このポップアップにキャンセルボタンを配置する。
    var abortController = typeof AbortController !== 'undefined' ? new AbortController() : null
    if (window.SalonSyncModal) {
      window.SalonSyncModal.show('サロンボードからブログを読み込んでいます...', function () {
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
      status.textContent = e && e.name === 'AbortError' ? 'キャンセルしました' : '通信エラーが発生しました'
    } finally {
      if (window.SalonSyncModal) window.SalonSyncModal.hide()
      btn.disabled = false
    }
  })
})

// 取り込んだ過去の記事一覧: 全選択/全解除ボタン
document.addEventListener('DOMContentLoaded', () => {
  var selectAllBtn = document.getElementById('blog-ref-select-all-btn')
  var deselectAllBtn = document.getElementById('blog-ref-deselect-all-btn')
  if (!selectAllBtn && !deselectAllBtn) return

  function setAll(checked) {
    document.querySelectorAll('.blog-ref-checkbox').forEach(function (cb) {
      cb.checked = checked
    })
  }
  if (selectAllBtn) selectAllBtn.addEventListener('click', function () { setAll(true) })
  if (deselectAllBtn) deselectAllBtn.addEventListener('click', function () { setAll(false) })
})
