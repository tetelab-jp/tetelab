document.addEventListener('DOMContentLoaded', () => {
  const salonTypeLabel = (type) => (type === 'kirei' ? 'キレイサロン' : 'ヘアサロン')

  // 複数サロン対応: /settings/salonboard のオンボーディング・ウィザード。
  // サロンボード連携がまだ確定していない(サロンIDが未確定の)場合、ページ
  // 読み込み時に自動でログイン・サロン検知を試みる(手動でボタンを押す
  // 必要がない)。ヘアサロンが2件以上見つかった場合のみ「契約する店舗数」の
  // 質問を挟む。キレイサロンの専用ダッシュボードは当面用意しないため、
  // このウィザードで選択できるのは常にヘアサロンのみ。
  // 注意: /dashboardには#sync-stylists-coupons-btnが存在するが、ここ
  // (/settings/salonboard)には存在しないため、下の「同期ボタン」用の
  // コード(if (!btn) returnで早期リターンする)より前に配置する。
  const onboardingArea = document.getElementById('salonboard-onboarding-area')
  if (onboardingArea && onboardingArea.dataset.autorun === '1') {
    runOnboardingWizard(onboardingArea)
  }

  function clearAndAppendText(container, className, text) {
    container.innerHTML = ''
    const p = document.createElement('p')
    p.className = className
    p.textContent = text
    container.appendChild(p)
  }

  async function runOnboardingWizard(area) {
    clearAndAppendText(area, 'text-sm text-gray-500', 'サロンボードへのログインを確認しています...（1分ほどかかる場合があります）')
    try {
      const res = await fetch('/api/settings/sync-stylists-coupons', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        clearAndAppendText(area, 'text-sm text-green-600', '連携が完了しました。ダッシュボードに移動します...')
        setTimeout(() => {
          window.location.href = '/dashboard'
        }, 1200)
        return
      }
      if (data.needsSalonSelection) {
        const hairSalons = (data.salons || []).filter((s) => s.type !== 'kirei')
        if (hairSalons.length === 0) {
          clearAndAppendText(area, 'text-sm text-red-600', '利用可能なヘアサロンが見つかりませんでした')
          return
        }
        if (hairSalons.length === 1) {
          // キレイサロンが混在しているだけで、ヘアサロンは実質1件のみ→即確定する
          await selectOnboardingSalon(area, hairSalons[0].storeId)
          return
        }
        renderContractCountStep(area, hairSalons)
        return
      }
      clearAndAppendText(area, 'text-sm text-red-600', 'エラー: ' + (data.error || '不明なエラー'))
    } catch (e) {
      clearAndAppendText(area, 'text-sm text-red-600', '通信エラーが発生しました')
    }
  }

  function renderContractCountStep(area, hairSalons) {
    const n = hairSalons.length
    area.innerHTML = ''

    const box = document.createElement('div')
    box.className = 'bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-3'

    const title = document.createElement('p')
    title.className = 'text-sm font-semibold text-gray-700'
    title.textContent = 'このアカウントには複数のサロン（' + n + '件）が登録されています。契約する店舗数を選択してください。'
    box.appendChild(title)

    const allLabel = document.createElement('label')
    allLabel.className = 'flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm cursor-pointer'
    const allRadio = document.createElement('input')
    allRadio.type = 'radio'
    allRadio.name = 'contract-count-mode'
    allRadio.value = 'all'
    allRadio.checked = true
    allLabel.appendChild(allRadio)
    const allText = document.createElement('span')
    allText.textContent = '全ての店舗を利用する（' + n + '店舗）'
    allLabel.appendChild(allText)
    box.appendChild(allLabel)

    const partialLabel = document.createElement('label')
    partialLabel.className = 'flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm cursor-pointer'
    const partialRadio = document.createElement('input')
    partialRadio.type = 'radio'
    partialRadio.name = 'contract-count-mode'
    partialRadio.value = 'partial'
    partialLabel.appendChild(partialRadio)
    const partialTextBefore = document.createElement('span')
    partialTextBefore.textContent = '一部の店舗を利用する（' + n + '店舗中'
    partialLabel.appendChild(partialTextBefore)
    const countSelect = document.createElement('select')
    countSelect.className = 'mx-1 rounded border border-gray-300 text-sm'
    countSelect.disabled = true
    for (let i = 1; i < n; i++) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = String(i)
      countSelect.appendChild(opt)
    }
    partialLabel.appendChild(countSelect)
    const partialTextAfter = document.createElement('span')
    partialTextAfter.textContent = '店舗）'
    partialLabel.appendChild(partialTextAfter)
    box.appendChild(partialLabel)

    allRadio.addEventListener('change', () => {
      countSelect.disabled = true
    })
    partialRadio.addEventListener('change', () => {
      countSelect.disabled = false
    })

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm'
    confirmBtn.textContent = '次へ進む'
    box.appendChild(confirmBtn)

    const statusEl = document.createElement('p')
    statusEl.className = 'text-sm'
    box.appendChild(statusEl)

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true
      statusEl.textContent = '保存中...'
      const mode = partialRadio.checked ? 'partial' : 'all'
      try {
        const body = new URLSearchParams()
        body.set('mode', mode)
        if (mode === 'partial') body.set('count', countSelect.value)
        const res = await fetch('/api/settings/onboarding/set-contract-count', { method: 'POST', body })
        const data = await res.json()
        if (!data.success) {
          statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
          confirmBtn.disabled = false
          return
        }
        if (mode === 'all') {
          statusEl.textContent = '確定しました。同期しています...'
          runOnboardingWizard(area)
        } else {
          renderOnboardingSalonPicker(area, hairSalons)
        }
      } catch (e) {
        statusEl.textContent = '通信エラーが発生しました'
        confirmBtn.disabled = false
      }
    })

    area.appendChild(box)
  }

  function renderOnboardingSalonPicker(area, hairSalons) {
    area.innerHTML = ''
    const box = document.createElement('div')
    box.className = 'bg-yellow-50 border border-yellow-200 rounded-lg p-4 space-y-3'

    const title = document.createElement('p')
    title.className = 'text-sm font-semibold text-gray-700'
    title.textContent = '利用するサロンを1件選択してください。'
    box.appendChild(title)

    const list = document.createElement('div')
    list.className = 'space-y-2'
    hairSalons.forEach((salon, i) => {
      const label = document.createElement('label')
      label.className = 'flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm cursor-pointer'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'onboarding-salon-radio'
      radio.value = salon.storeId
      if (i === 0) radio.checked = true
      label.appendChild(radio)
      const text = document.createElement('span')
      text.textContent = salon.name + '（' + salon.storeId + '）'
      label.appendChild(text)
      list.appendChild(label)
    })
    box.appendChild(list)

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.className = 'w-full md:w-auto bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg text-sm'
    confirmBtn.textContent = 'このサロンを使う'
    box.appendChild(confirmBtn)

    const statusEl = document.createElement('p')
    statusEl.className = 'text-sm'
    box.appendChild(statusEl)

    confirmBtn.addEventListener('click', async () => {
      const checked = list.querySelector('input[name="onboarding-salon-radio"]:checked')
      if (!checked) return
      confirmBtn.disabled = true
      statusEl.textContent = '選択を保存中...'
      const ok = await selectOnboardingSalon(area, checked.value)
      if (!ok) {
        confirmBtn.disabled = false
      }
    })

    area.appendChild(box)
  }

  async function selectOnboardingSalon(area, storeId) {
    clearAndAppendText(area, 'text-sm text-gray-500', 'サロンを確定しています...')
    try {
      const body = new URLSearchParams()
      body.set('storeId', storeId)
      const res = await fetch('/api/settings/select-salon', { method: 'POST', body })
      const data = await res.json()
      if (data.success) {
        runOnboardingWizard(area)
        return true
      }
      clearAndAppendText(area, 'text-sm text-red-600', 'エラー: ' + (data.error || '不明なエラー'))
      return false
    } catch (e) {
      clearAndAppendText(area, 'text-sm text-red-600', '通信エラーが発生しました')
      return false
    }
  }

  // ---------- ここから /dashboard の「サロンボードと同期する」ボタン ----------

  const btn = document.getElementById('sync-stylists-coupons-btn')
  const statusEl = document.getElementById('sync-stylists-coupons-status')
  const selectArea = document.getElementById('salon-select-area')
  if (!btn) return

  const originalText = btn.textContent

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

  // 複数サロンワークスペース対応 フェーズ4: 追加サロン選択
  const fetchAvailableBtn = document.getElementById('fetch-available-salons-btn')
  const fetchAvailableStatusEl = document.getElementById('fetch-available-salons-status')
  const additionalArea = document.getElementById('additional-salon-area')

  if (fetchAvailableBtn && additionalArea) {
    const fetchOriginalText = fetchAvailableBtn.textContent

    function renderAdditionalSalonSelect(salons) {
      additionalArea.innerHTML = ''
      if (salons.length === 0) {
        const p = document.createElement('p')
        p.className = 'text-sm text-gray-500'
        p.textContent = '追加できるサロンが見つかりませんでした(既に全て利用中の可能性があります)'
        additionalArea.appendChild(p)
        return
      }

      const box = document.createElement('div')
      box.className = 'bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-3'

      const list = document.createElement('div')
      list.className = 'space-y-2'
      salons.forEach((salon, i) => {
        const label = document.createElement('label')
        label.className =
          'flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-3 py-2 text-sm cursor-pointer'
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'additional-salon-radio'
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
      confirmBtn.textContent = 'このサロンを追加する'
      box.appendChild(confirmBtn)

      const confirmStatusEl = document.createElement('p')
      confirmStatusEl.className = 'text-sm'
      box.appendChild(confirmStatusEl)

      confirmBtn.addEventListener('click', async () => {
        const checked = list.querySelector('input[name="additional-salon-radio"]:checked')
        if (!checked) return
        confirmBtn.disabled = true
        confirmStatusEl.textContent = '追加中...'
        try {
          const body = new URLSearchParams()
          body.set('storeId', checked.value)
          const res = await fetch('/api/settings/activate-additional-salon', { method: 'POST', body })
          const data = await res.json()
          if (data.success) {
            confirmStatusEl.textContent = '追加しました。反映のためページを更新します...'
            setTimeout(() => {
              window.location.reload()
            }, 1200)
          } else {
            confirmStatusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
            confirmBtn.disabled = false
          }
        } catch (e) {
          confirmStatusEl.textContent = '通信エラーが発生しました'
          confirmBtn.disabled = false
        }
      })

      additionalArea.appendChild(box)
    }

    fetchAvailableBtn.addEventListener('click', async () => {
      fetchAvailableBtn.disabled = true
      fetchAvailableBtn.textContent = 'サロンボードを確認中...'
      fetchAvailableStatusEl.textContent = 'サロンボードを確認中...（1分ほどかかる場合があります）'
      try {
        const res = await fetch('/api/settings/fetch-available-salons', { method: 'POST' })
        const data = await res.json()
        if (data.success) {
          fetchAvailableStatusEl.textContent = '追加できるサロンを選択してください'
          renderAdditionalSalonSelect(data.salons || [])
        } else {
          fetchAvailableStatusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
        }
      } catch (e) {
        fetchAvailableStatusEl.textContent = '通信エラーが発生しました'
      } finally {
        fetchAvailableBtn.disabled = false
        fetchAvailableBtn.textContent = fetchOriginalText
      }
    })
  }
})
