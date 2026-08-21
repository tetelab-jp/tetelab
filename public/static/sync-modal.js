// サロンボード連携の同期系ボタン(サロンボードと同期する/サロンボードから
// スタイル取得/サロンボードからブログ読み込み/順位測定/サロンボードから
// 口コミを同期)共通の、操作不能な待機ポップアップ(2026-08-21追記・
// ユーザー指定: ページ遷移させず待ってもらう目的)。
// components/layout.tsxのPageLayoutから全ページで読み込まれるため、
// 各ページのJSからは window.SalonSyncModal.show(text, onCancel) / .update(text) /
// .hide() を呼ぶだけでよい。モーダル自体のDOMは初回show()時に生成する。
// 2026-08-22追記(ユーザー指定): すべての画面のこのポップアップに
// キャンセルボタンを配置する。show()の第2引数にキャンセル時のコールバックを
// 渡すと押下時に呼ばれる(呼び出し元でfetchのAbortController.abort()や
// ポーリングの停止を行う想定)。渡さなかった場合もモーダルを閉じるだけの
// 動作にはなる(操作不能状態を必ず解除できるようにする)。
;(function () {
  var currentOnCancel = null

  function ensureModal() {
    var modal = document.getElementById('sync-wait-modal')
    if (modal) return modal
    modal = document.createElement('div')
    modal.id = 'sync-wait-modal'
    modal.className = 'hidden fixed inset-0 z-50 items-center justify-center bg-black/50 p-4'
    modal.innerHTML =
      '<div class="bg-white rounded-xl p-6 max-w-sm w-full text-center space-y-3">' +
      '<i class="fas fa-circle-notch fa-spin text-3xl text-pink-500"></i>' +
      '<p id="sync-wait-modal-text" class="font-semibold"></p>' +
      '<button type="button" id="sync-wait-modal-cancel-btn" class="text-sm text-gray-400 hover:text-gray-600 underline">キャンセル</button>' +
      '</div>'
    document.body.appendChild(modal)
    var cancelBtn = modal.querySelector('#sync-wait-modal-cancel-btn')
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        var cb = currentOnCancel
        currentOnCancel = null
        if (cb) cb()
        hide()
      })
    }
    return modal
  }

  function show(text, onCancel) {
    var modal = ensureModal()
    currentOnCancel = typeof onCancel === 'function' ? onCancel : null
    update(text || '処理中...')
    modal.classList.remove('hidden')
    modal.classList.add('flex')
  }

  function update(text) {
    var textEl = document.getElementById('sync-wait-modal-text')
    if (textEl) textEl.textContent = text
  }

  function hide() {
    var modal = document.getElementById('sync-wait-modal')
    currentOnCancel = null
    if (!modal) return
    modal.classList.add('hidden')
    modal.classList.remove('flex')
  }

  window.SalonSyncModal = { show: show, update: update, hide: hide }
})()
