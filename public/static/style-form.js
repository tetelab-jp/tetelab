// スタイル/テンプレート作成・編集フォームの操作用JS
// カテゴリ（レディース/メンズ）に応じて、対応する「長さ」セレクトのみ表示する
document.addEventListener('DOMContentLoaded', () => {
  const categoryRadios = document.querySelectorAll('.category-radio')
  const lengthSelects = document.querySelectorAll('.length-select')

  function updateLengthSelects() {
    const checked = document.querySelector('.category-radio:checked')
    const activeCat = checked ? checked.value : 'SG01'
    lengthSelects.forEach((select) => {
      if (select.dataset.cat === activeCat) {
        select.classList.remove('hidden')
      } else {
        select.classList.add('hidden')
        select.value = ''
      }
    })
  }

  categoryRadios.forEach((radio) => {
    radio.addEventListener('change', updateLengthSelects)
  })

  if (categoryRadios.length > 0) {
    updateLengthSelects()
  }
})
