// 記事編集ページ(/blog/articles/:id/edit)の承認・AI再生成ボタン用JS
document.addEventListener('DOMContentLoaded', () => {
  var approveBtn = document.getElementById('article-approve-btn')
  if (approveBtn) {
    approveBtn.addEventListener('click', async function () {
      var articleId = approveBtn.getAttribute('data-article-id')
      approveBtn.disabled = true
      try {
        var res = await fetch(`/api/blog/articles/${articleId}/approve`, { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          location.reload()
        } else {
          alert('承認に失敗しました')
          approveBtn.disabled = false
        }
      } catch (e) {
        alert('通信エラーが発生しました')
        approveBtn.disabled = false
      }
    })
  }

  var unapproveBtn = document.getElementById('article-unapprove-btn')
  if (unapproveBtn) {
    unapproveBtn.addEventListener('click', async function () {
      var articleId = unapproveBtn.getAttribute('data-article-id')
      unapproveBtn.disabled = true
      try {
        await fetch(`/api/blog/articles/${articleId}/unapprove`, { method: 'POST' })
      } finally {
        location.reload()
      }
    })
  }

  var regenDescBtn = document.getElementById('article-regen-description-btn')
  if (regenDescBtn) {
    regenDescBtn.addEventListener('click', async function () {
      var articleId = regenDescBtn.getAttribute('data-article-id')
      regenDescBtn.disabled = true
      var originalText = regenDescBtn.innerHTML
      regenDescBtn.textContent = '生成中...'
      try {
        var res = await fetch(`/api/blog/articles/${articleId}/regenerate-description`, { method: 'POST' })
        var data = await res.json()
        if (!data.success) alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
      } catch (e) {
        alert('通信エラーが発生しました')
      } finally {
        regenDescBtn.disabled = false
        regenDescBtn.innerHTML = originalText
      }
    })
  }

  var regenBodyBtn = document.getElementById('article-regen-body-btn')
  if (regenBodyBtn) {
    regenBodyBtn.addEventListener('click', async function () {
      var articleId = regenBodyBtn.getAttribute('data-article-id')
      var bodyTextarea = document.querySelector('textarea[name="body"]')
      var titleInput = document.querySelector('input[name="title"]')
      regenBodyBtn.disabled = true
      var originalText = regenBodyBtn.innerHTML
      regenBodyBtn.textContent = '生成中...'
      try {
        var res = await fetch(`/api/blog/articles/${articleId}/regenerate-body`, { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          if (titleInput) titleInput.value = data.title || ''
          if (bodyTextarea) bodyTextarea.value = data.body || ''
        } else {
          alert('生成に失敗しました: ' + (data.error || '不明なエラー'))
        }
      } catch (e) {
        alert('通信エラーが発生しました')
      } finally {
        regenBodyBtn.disabled = false
        regenBodyBtn.innerHTML = originalText
      }
    })
  }
})
