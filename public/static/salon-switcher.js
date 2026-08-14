// 複数サロンワークスペース対応: サイドバー(PC/モバイル)のサロン切り替えUI。
// 有効化済みワークスペースが2件以上の場合のみ描画する(単一サロンの
// アカウントには何も表示されない)。全ページ共通(layout.tsxのPageLayoutから読み込み)。
document.addEventListener('DOMContentLoaded', async () => {
  const desktopArea = document.getElementById('salon-switcher-area')
  const mobileArea = document.getElementById('salon-switcher-area-mobile')
  if (!desktopArea && !mobileArea) return

  try {
    const res = await fetch('/api/settings/active-salons')
    const data = await res.json()
    if (!data.success || !Array.isArray(data.salons) || data.salons.length < 2) return

    const salonTypeLabel = (type) => (type === 'kirei' ? 'キレイサロン' : 'ヘアサロン')

    function buildSwitcher() {
      const wrap = document.createElement('div')
      wrap.className = 'px-1'

      const label = document.createElement('p')
      label.className = 'text-[11px] font-semibold text-gray-400 mb-1'
      label.textContent = '利用中のサロン'
      wrap.appendChild(label)

      const select = document.createElement('select')
      select.className = 'w-full rounded-lg border border-gray-300 px-2 py-2 text-sm font-medium text-gray-700 bg-white'
      data.salons.forEach((salon) => {
        const opt = document.createElement('option')
        opt.value = String(salon.id)
        opt.textContent = salon.name + '（' + salonTypeLabel(salon.type) + '）'
        opt.selected = salon.id === data.activeSalonId
        select.appendChild(opt)
      })
      wrap.appendChild(select)

      const statusEl = document.createElement('p')
      statusEl.className = 'text-xs text-gray-400 mt-1'
      wrap.appendChild(statusEl)

      select.addEventListener('change', async () => {
        select.disabled = true
        statusEl.textContent = '切り替え中...'
        try {
          const body = new URLSearchParams()
          body.set('salonId', select.value)
          const switchRes = await fetch('/api/settings/switch-salon', { method: 'POST', body })
          const switchData = await switchRes.json()
          if (switchData.success) {
            window.location.reload()
          } else {
            statusEl.textContent = 'エラー: ' + (switchData.error || '不明なエラー')
            select.disabled = false
          }
        } catch (e) {
          statusEl.textContent = '通信エラーが発生しました'
          select.disabled = false
        }
      })

      return wrap
    }

    if (desktopArea) desktopArea.appendChild(buildSwitcher())
    if (mobileArea) mobileArea.appendChild(buildSwitcher())
  } catch (e) {
    // サロン切り替え情報の取得に失敗しても、通常のページ表示は継続する
  }
})
