// アカウント設定ページ: メールアドレス変更・パスワード変更、それぞれ
// 「変更する」ボタンを押すまで入力欄を隠す(2つ独立)
document.addEventListener('DOMContentLoaded', () => {
  function wireToggle(openBtnId, triggerId, formId) {
    var openBtn = document.getElementById(openBtnId)
    var trigger = document.getElementById(triggerId)
    var form = document.getElementById(formId)
    if (!openBtn || !trigger || !form) return
    openBtn.addEventListener('click', () => {
      trigger.classList.add('hidden')
      form.classList.remove('hidden')
    })
  }

  wireToggle('email-edit-open-btn', 'email-edit-trigger', 'email-edit-form')
  wireToggle('password-edit-open-btn', 'password-edit-trigger', 'password-edit-form')
})
