// 全ページ共通: textareaを、内容が表示領域を超えた場合に(内部スクロール/
// 見切れではなく)高さ自体を広げて全文表示する。PageLayoutから全ページに
// 読み込まれる(2026-08-18追記・ユーザー指定)。
document.addEventListener('DOMContentLoaded', () => {
  function resize(el) {
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }

  function wire(el) {
    if (el.dataset.autosizeWired) return
    el.dataset.autosizeWired = '1'
    el.style.overflowY = 'hidden'
    resize(el)
    el.addEventListener('input', () => resize(el))
  }

  document.querySelectorAll('textarea').forEach(wire)

  // JS側で動的に追加・表示されるtextarea(口コミ返信欄など)にも対応する。
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return
        if (node.tagName === 'TEXTAREA') wire(node)
        node.querySelectorAll && node.querySelectorAll('textarea').forEach(wire)
      })
    })
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // display:none状態から表示に切り替わった場合(hiddenクラス解除など)に
  // scrollHeightが正しく取れるよう、クリック等のタイミングでも再計算する。
  document.addEventListener(
    'focus',
    (e) => {
      if (e.target && e.target.tagName === 'TEXTAREA') resize(e.target)
    },
    true
  )
})
