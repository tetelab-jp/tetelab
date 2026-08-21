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
        // 2026-08-14追記(ユーザー指定): 複数サロンが検出された場合、これまでは
        // 「契約する店舗数」→「利用するサロンを選択」というウィザードを画面上で
        // 進めてもらっていたが、サインアップ側の作業はサロンボードのログイン情報
        // 入力までで完了とし、以降の店舗選択・有効化は管理者サイト(/admin/salons)
        // 側で管理者が行う運用に変更した。検出したサロン一覧はサーバー側で既に
        // salonboard_salonsへ保存済みなので、ここでは案内メッセージのみ表示する。
        clearAndAppendText(
          area,
          'text-sm text-green-600',
          'サロンボードとの連携情報を確認しました。複数の店舗が検出されたため、運営にて設定を行います。今しばらくお待ちください。'
        )
        return
      }
      clearAndAppendText(area, 'text-sm text-red-600', 'エラー: ' + (data.error || '不明なエラー'))
    } catch (e) {
      clearAndAppendText(area, 'text-sm text-red-600', '通信エラーが発生しました')
    }
  }

  // 2026-08-14追記: 複数サロン検出時の「契約する店舗数」「利用するサロンを
  // 選択」ウィザードUI(renderContractCountStep/renderOnboardingSalonPicker)は
  // ユーザー指定により撤去した(以降は管理者サイトで運営が設定する運用のため)。
  // ヘアサロンが実質1件のみの場合の自動確定にはselectOnboardingSalonを
  // 引き続き使う。

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
    // 2026-08-21追記(ユーザー指定): 同期中はページ遷移させないよう、操作不能の
    // 待機ポップアップを表示する(public/static/sync-modal.js、全ページ共通)。
    if (window.SalonSyncModal) window.SalonSyncModal.show('サロンボードと同期しています…')
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
      if (window.SalonSyncModal) window.SalonSyncModal.hide()
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
