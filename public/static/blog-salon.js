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

// 取り込んだ過去の記事一覧: 100件ずつのページ表示+全選択/全解除ボタン
// (既存スタイル取り込みの100件ページネーションと同じ考え方。データは
// サーバー側で既に全件レンダリング済みのため、ページ切り替えはli[data-page]の
// 表示/非表示で行う。選択はページをまたいでも保持される)
document.addEventListener('DOMContentLoaded', () => {
  var list = document.getElementById('blog-ref-list')
  var selectAllBtn = document.getElementById('blog-ref-select-all-btn')
  var deselectAllBtn = document.getElementById('blog-ref-deselect-all-btn')
  if (!list) return

  var PAGE_SIZE = 100
  var items = Array.prototype.slice.call(list.querySelectorAll('li[data-page]'))
  var totalPages = items.reduce(function (max, li) {
    return Math.max(max, Number(li.getAttribute('data-page')) || 1)
  }, 1)
  var currentPage = 1

  var paginationEl = document.getElementById('blog-ref-pagination')
  var paginationLabelEl = document.getElementById('blog-ref-pagination-label')
  var firstBtn = document.getElementById('blog-ref-page-first')
  var back5Btn = document.getElementById('blog-ref-page-back5')
  var prevBtn = document.getElementById('blog-ref-page-prev')
  var nextBtn = document.getElementById('blog-ref-page-next')
  var fwd5Btn = document.getElementById('blog-ref-page-fwd5')
  var lastBtn = document.getElementById('blog-ref-page-last')

  function renderPage() {
    var visibleCount = 0
    items.forEach(function (li) {
      var isCurrent = Number(li.getAttribute('data-page')) === currentPage
      li.classList.toggle('hidden', !isCurrent)
      if (isCurrent) visibleCount += 1
    })
    if (paginationEl) {
      if (totalPages > 1) {
        paginationEl.classList.remove('hidden')
        paginationEl.classList.add('flex')
        var start = (currentPage - 1) * PAGE_SIZE
        if (paginationLabelEl) {
          paginationLabelEl.textContent =
            (start + 1) + '〜' + (start + visibleCount) + '件 / 全' + items.length + '件（' + currentPage + ' / ' + totalPages + 'ページ）'
        }
        var atFirst = currentPage <= 1
        var atLast = currentPage >= totalPages
        if (firstBtn) firstBtn.disabled = atFirst
        if (back5Btn) back5Btn.disabled = atFirst
        if (prevBtn) prevBtn.disabled = atFirst
        if (nextBtn) nextBtn.disabled = atLast
        if (fwd5Btn) fwd5Btn.disabled = atLast
        if (lastBtn) lastBtn.disabled = atLast
      } else {
        paginationEl.classList.add('hidden')
        paginationEl.classList.remove('flex')
      }
    }
  }
  renderPage()

  function goToPage(page) {
    currentPage = Math.min(Math.max(1, page), totalPages)
    renderPage()
    list.scrollIntoView({ block: 'start' })
  }
  if (firstBtn) firstBtn.addEventListener('click', function () { goToPage(1) })
  if (back5Btn) back5Btn.addEventListener('click', function () { goToPage(currentPage - 5) })
  if (prevBtn) prevBtn.addEventListener('click', function () { goToPage(currentPage - 1) })
  if (nextBtn) nextBtn.addEventListener('click', function () { goToPage(currentPage + 1) })
  if (fwd5Btn) fwd5Btn.addEventListener('click', function () { goToPage(currentPage + 5) })
  if (lastBtn) lastBtn.addEventListener('click', function () { goToPage(totalPages) })

  // 全選択/全解除は現在表示中のページの記事だけを対象にする
  // (既存スタイル取り込みで、全ページ分が対象になってしまっていた不具合の
  // 再発防止と同じ考え方)。
  function setCurrentPage(checked) {
    items.forEach(function (li) {
      if (Number(li.getAttribute('data-page')) !== currentPage) return
      var cb = li.querySelector('.blog-ref-checkbox')
      if (cb) cb.checked = checked
    })
  }
  if (selectAllBtn) selectAllBtn.addEventListener('click', function () { setCurrentPage(true) })
  if (deselectAllBtn) deselectAllBtn.addEventListener('click', function () { setCurrentPage(false) })
})
