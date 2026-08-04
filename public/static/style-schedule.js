// スタイル自動投稿スケジュール画面の操作用JS
document.addEventListener('DOMContentLoaded', () => {
  const select = document.getElementById('times-per-day-select')
  const inputs = document.querySelectorAll('.run-time-input')

  function updateVisibleInputs() {
    const count = Number(select.value)
    inputs.forEach((input, i) => {
      if (i < count) {
        input.classList.remove('hidden')
      } else {
        input.classList.add('hidden')
        input.value = ''
      }
    })
  }

  if (select) {
    select.addEventListener('change', updateVisibleInputs)
  }
})
