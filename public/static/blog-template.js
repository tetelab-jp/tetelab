// 生成テンプレートページの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  // 画像選択したら自動でアップロードフォームを送信
  var imageInput = document.getElementById('blog-image-input')
  var uploadForm = document.getElementById('blog-image-upload-form')
  var uploadStatus = document.getElementById('blog-image-upload-status')
  if (imageInput && uploadForm) {
    imageInput.addEventListener('change', function () {
      if (imageInput.files.length === 0) return
      if (uploadStatus) uploadStatus.textContent = `${imageInput.files.length}枚をアップロード中...`
      uploadForm.submit()
    })
  }

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

  // 1本だけ試しに書かせる(プレビュー、保存しない)
  var previewBtn = document.getElementById('generate-preview-btn')
  if (previewBtn) {
    previewBtn.addEventListener('click', async function () {
      var categoryId = previewBtn.getAttribute('data-category-id')
      var status = document.getElementById('generate-status')
      var resultBox = document.getElementById('generate-preview-result')
      previewBtn.disabled = true
      status.textContent = '生成中...'
      try {
        var res = await fetch(`/api/blog/categories/${categoryId}/generate-preview`, { method: 'POST' })
        var data = await res.json()
        if (data.success) {
          document.getElementById('generate-preview-title').textContent = data.title
          document.getElementById('generate-preview-body').textContent = data.body
          resultBox.classList.remove('hidden')
          status.textContent = ''
        } else {
          status.textContent = 'エラー: ' + (data.error || '不明なエラー')
        }
      } catch (e) {
        status.textContent = '通信エラーが発生しました'
      } finally {
        previewBtn.disabled = false
      }
    })
  }

  // この記事カテゴリの記事を一括生成(バックグラウンド進行、ポーリングで進捗表示)
  var batchBtn = document.getElementById('generate-batch-btn')
  if (batchBtn) {
    batchBtn.addEventListener('click', async function () {
      var categoryId = batchBtn.getAttribute('data-category-id')
      var status = document.getElementById('generate-status')
      batchBtn.disabled = true
      try {
        var res = await fetch(`/api/blog/categories/${categoryId}/generate-batch`, { method: 'POST' })
        var data = await res.json()
        if (!data.success) {
          status.textContent = 'エラー: ' + (data.error || '不明なエラー')
          batchBtn.disabled = false
          return
        }
        if (data.count === 0) {
          status.textContent = '対象の写真がありません'
          batchBtn.disabled = false
          return
        }
        status.textContent = `${data.count}件を生成中...`
        pollStatus(categoryId, data.count, status)
      } catch (e) {
        status.textContent = '通信エラーが発生しました'
        batchBtn.disabled = false
      }
    })
  }

  function pollStatus(categoryId, total, status) {
    var interval = setInterval(async function () {
      try {
        var res = await fetch(`/api/blog/categories/${categoryId}/generation-status`)
        var data = await res.json()
        var counts = {}
        ;(data.counts || []).forEach(function (row) {
          counts[row.status] = row.cnt
        })
        var remaining = counts['generating'] || 0
        if (remaining === 0) {
          clearInterval(interval)
          status.textContent = '生成が完了しました'
          setTimeout(function () {
            location.reload()
          }, 800)
        } else {
          status.textContent = `生成中... (残り約${remaining}件)`
        }
      } catch (e) {
        // 通信エラーは無視して次回ポーリングへ
      }
    }, 5000)
  }
})
