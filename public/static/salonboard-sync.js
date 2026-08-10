document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('sync-stylists-coupons-btn')
  const statusEl = document.getElementById('sync-stylists-coupons-status')
  if (!btn) return

  btn.addEventListener('click', async () => {
    btn.disabled = true
    statusEl.textContent = 'サロンボードと同期中...（1分ほどかかる場合があります）'
    try {
      const res = await fetch('/api/settings/sync-stylists-coupons', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        statusEl.textContent =
          '完了: スタイリスト ' + data.stylistCount + '件、クーポン ' + data.couponCount + '件を同期しました'
        setTimeout(() => {
          window.location.reload()
        }, 1500)
      } else {
        statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
      }
    } catch (e) {
      statusEl.textContent = '通信エラーが発生しました'
    } finally {
      btn.disabled = false
    }
  })
})
