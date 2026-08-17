// アカウント設定ページ: 「変更する」ボタンを押すまで入力欄を隠す
document.addEventListener('DOMContentLoaded', () => {
  const openBtn = document.getElementById('account-edit-open-btn')
  const trigger = document.getElementById('account-edit-trigger')
  const form = document.getElementById('account-edit-form')
  if (!openBtn || !trigger || !form) return

  openBtn.addEventListener('click', () => {
    trigger.classList.add('hidden')
    form.classList.remove('hidden')
  })
})
