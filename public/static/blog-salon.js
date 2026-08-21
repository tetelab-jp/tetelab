// サロン基本情報ページ: サロンボード同期ボタン
document.addEventListener('DOMContentLoaded', () => {
  var btn = document.getElementById('blog-salon-sync-btn')
  var status = document.getElementById('blog-salon-sync-status')
  if (!btn) return

  btn.addEventListener('click', async function () {
    btn.disabled = true
    status.textContent = 'サロンボードから読み込み中...(数十秒かかることがあります)'
    if (window.SalonSyncModal) window.SalonSyncModal.show('サロンボードからブログを読み込んでいます...')
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
      if (window.SalonSyncModal) window.SalonSyncModal.hide()
      btn.disabled = false
    }
  })
})

// サロン基本情報ページ: 「サロンの人格」AI生成ボタン
document.addEventListener('DOMContentLoaded', () => {
  var btn = document.getElementById('persona-generate-btn')
  var status = document.getElementById('persona-generate-status')
  if (!btn) return

  btn.addEventListener('click', async function () {
    btn.disabled = true
    status.textContent = 'AIで生成中...'
    try {
      var res = await fetch('/api/blog/salon/generate-persona', { method: 'POST' })
      var data = await res.json()
      if (data.success) {
        document.getElementById('persona-concept').value = data.concept || ''
        document.getElementById('persona-strengths').value = data.strengths || ''
        document.getElementById('persona-target-customer').value = data.target_customer || ''
        document.getElementById('persona-price-range').value = data.price_range || ''
        status.textContent = '生成しました。内容を確認して「保存する」を押してください'
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

// 取り込んだ過去の記事一覧: クリックで内容を確認するモーダル
document.addEventListener('DOMContentLoaded', () => {
  var modal = document.getElementById('blog-ref-view-modal')
  if (!modal) return
  var titleEl = document.getElementById('blog-ref-view-title')
  var dateEl = document.getElementById('blog-ref-view-date')
  var contentEl = document.getElementById('blog-ref-view-content')
  var closeBtn = document.getElementById('blog-ref-view-close-btn')

  function openModal(btn) {
    titleEl.textContent = btn.getAttribute('data-title') || ''
    dateEl.textContent = btn.getAttribute('data-date') || ''
    contentEl.textContent = btn.getAttribute('data-content') || ''
    modal.classList.remove('hidden')
    modal.classList.add('flex')
  }
  function closeModal() {
    modal.classList.add('hidden')
    modal.classList.remove('flex')
  }

  document.querySelectorAll('.blog-ref-view-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { openModal(btn) })
  })
  if (closeBtn) closeBtn.addEventListener('click', closeModal)
  modal.addEventListener('click', function (e) {
    if (e.target === modal) closeModal()
  })
})
