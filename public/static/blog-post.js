// ブログ投稿作成画面：AI生成ボタンの操作用JS
document.addEventListener('DOMContentLoaded', () => {
  const generateBtn = document.getElementById('ai-generate-btn')
  const keywordsInput = document.getElementById('ai-keywords')
  const titleInput = document.getElementById('title-input')
  const contentTextarea = document.getElementById('content-textarea')
  const statusEl = document.getElementById('ai-status')

  if (!generateBtn) return

  generateBtn.addEventListener('click', async () => {
    const keywords = keywordsInput.value.trim()
    if (!keywords) {
      alert('キーワードを入力してください')
      return
    }

    generateBtn.disabled = true
    generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...'
    statusEl.classList.remove('hidden')
    statusEl.textContent = 'AIが本文を作成しています。しばらくお待ちください（10〜20秒程度）'

    try {
      const res = await fetch('/api/blog/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords })
      })
      const data = await res.json()
      if (data.success) {
        titleInput.value = data.title || ''
        contentTextarea.value = data.content || ''
        statusEl.textContent = '生成が完了しました。内容を確認・編集してください。'
      } else {
        statusEl.textContent = 'エラー: ' + (data.error || '生成に失敗しました')
      }
    } catch (err) {
      statusEl.textContent = 'エラー: 生成に失敗しました。しばらくしてから再度お試しください。'
    } finally {
      generateBtn.disabled = false
      generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i>AIで生成'
    }
  })
})
