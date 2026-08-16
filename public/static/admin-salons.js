// 契約サロン一覧: 無効化中のサロン行の開閉トグル
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.admin-toggle-inactive-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const accountId = btn.getAttribute('data-account-id')
      const rows = document.querySelectorAll(`[data-inactive-for="${accountId}"]`)
      if (rows.length === 0) return
      const willShow = rows[0].classList.contains('hidden')
      rows.forEach((row) => row.classList.toggle('hidden', !willShow))
      const icon = btn.querySelector('i')
      if (icon) icon.classList.toggle('rotate-90', willShow)
    })
  })
})
