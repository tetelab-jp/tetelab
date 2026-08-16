// 生成テンプレートページの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  // 伝えたいことのAI下書き生成
  var draftBtn = document.getElementById('generate-draft-btn')
  if (draftBtn) {
    draftBtn.addEventListener('click', async function () {
      var categoryId = draftBtn.getAttribute('data-category-id')
      var textarea = document.getElementById('key-message-input')
      draftBtn.disabled = true
      draftBtn.textContent = '生成中...'
      try {
        var res = await fetch(`/api/blog/categories/${categoryId}/generate-draft`, { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          textarea.value = data.draft
        } else {
          alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
        }
      } catch (e) {
        alert('通信エラーが発生しました')
      } finally {
        draftBtn.disabled = false
        draftBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>AIで下書き生成'
      }
    })
  }
})
