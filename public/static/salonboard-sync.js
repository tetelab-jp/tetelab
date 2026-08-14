document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('sync-stylists-coupons-btn')
  const statusEl = document.getElementById('sync-stylists-coupons-status')
  const selectArea = document.getElementById('salon-select-area')
  if (!btn) return

  const originalText = btn.textContent

  const salonTypeLabel = (type) => (type === 'kirei' ? 'キレイサロン' : 'ヘアサロン')

  function renderSalonSelect(salons) {
    if (!selectArea) return
    selectArea.innerHTML = ''

    const box = document.createElement('div')
    box.className = 'bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-3'

    const title = document.createElement('p')
    title.className = 'text-sm font-semibold text-gray-700'
    title.textContent = 'このアカウントには複数のサロンが登録されています。使用するサロンを選択してください。'
    box.appendChild(title)

    const warning = document.createElement('p')
    warning.className = 'text-xs text-red-600 leading-relaxed'
    warning.textContent =
      '※サロンの選択は最初の一回のみです。一度選択すると、以降このアカウントではスタイル投稿・ブログ・順位測定など全ての機能で選択したサロンのみが使用されます。後から他のサロンに切り替えることはできませんので、必ず正しいサロンを選択してください。'
    box.appendChild(warning)

    const list = document.createElement('div')
    list.className = 'space-y-2'
    salons.forEach((salon, i) => {
      const label = document.createElement('label')
      label.className =
        'flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm cursor-pointer'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'salon-select-radio'
      radio.value = salon.storeId
      if (i === 0) radio.checked = true
      label.appendChild(radio)
      const text = document.createElement('span')
      text.textContent = salon.name + '（' + salonTypeLabel(salon.type) + ' / ' + salon.storeId + '）'
      label.appendChild(text)
      list.appendChild(label)
    })
    box.appendChild(list)

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm'
    confirmBtn.textContent = 'このサロンを使う'
    box.appendChild(confirmBtn)

    const selectStatusEl = document.createElement('p')
    selectStatusEl.className = 'text-sm'
    box.appendChild(selectStatusEl)

    confirmBtn.addEventListener('click', async () => {
      const checked = list.querySelector('input[name="salon-select-radio"]:checked')
      if (!checked) return
      confirmBtn.disabled = true
      selectStatusEl.textContent = '選択を保存中...'
      try {
        const body = new URLSearchParams()
        body.set('storeId', checked.value)
        const res = await fetch('/api/settings/select-salon', { method: 'POST', body })
        const data = await res.json()
        if (data.success) {
          selectArea.innerHTML = ''
          runSync()
        } else {
          selectStatusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
          confirmBtn.disabled = false
        }
      } catch (e) {
        selectStatusEl.textContent = '通信エラーが発生しました'
        confirmBtn.disabled = false
      }
    })

    selectArea.appendChild(box)
  }

  async function runSync() {
    btn.disabled = true
    btn.textContent = 'サロンボードと同期中...'
    btn.classList.remove('bg-pink-500', 'hover:bg-pink-600')
    btn.classList.add('bg-gray-400')
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
      } else if (data.needsSalonSelection) {
        statusEl.textContent = data.error || 'サロンを選択してください'
        renderSalonSelect(data.salons || [])
      } else {
        statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
      }
    } catch (e) {
      statusEl.textContent = '通信エラーが発生しました'
    } finally {
      btn.disabled = false
      btn.textContent = originalText
      btn.classList.remove('bg-gray-400')
      btn.classList.add('bg-pink-500', 'hover:bg-pink-600')
    }
  }

  btn.addEventListener('click', runSync)
})
