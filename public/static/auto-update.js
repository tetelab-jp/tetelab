// 自動更新設定ページの操作用JS(スタイル・ブログの手動実行ボタン)
document.addEventListener('DOMContentLoaded', () => {
  const testRunBtn = document.getElementById('test-run-btn')
  if (testRunBtn) {
    testRunBtn.addEventListener('click', async () => {
      const status = document.getElementById('test-run-status')
      testRunBtn.disabled = true
      if (status) status.textContent = 'AWSへジョブを投入中...'
      try {
        const res = await fetch('/api/automation/test-run', { method: 'POST' })
        const data = await res.json()
        if (data.success) {
          if (status) status.textContent = (data.totalImages || 1) + 'スタイルを投稿します。投稿は自動で進むので待つ必要はありません。'
        } else {
          if (status) status.textContent = 'エラー: ' + (data.error || '不明なエラー')
        }
      } catch (e) {
        if (status) status.textContent = '通信エラーが発生しました'
      } finally {
        testRunBtn.disabled = false
      }
    })
  }

  const blogTestRunBtn = document.getElementById('blog-test-run-btn')
  if (blogTestRunBtn) {
    blogTestRunBtn.addEventListener('click', async () => {
      const status = document.getElementById('blog-test-run-status')
      blogTestRunBtn.disabled = true
      if (status) status.textContent = '投稿処理を開始しています...'
      try {
        const res = await fetch('/api/blog-automation/test-run', { method: 'POST' })
        const data = await res.json()
        if (data.success) {
          if (status) status.textContent = (data.totalArticles || 1) + '件のブログ記事を投稿します。投稿は自動で進むので待つ必要はありません。'
        } else {
          if (status) status.textContent = 'エラー: ' + (data.error || '不明なエラー')
          blogTestRunBtn.disabled = false
        }
      } catch (e) {
        if (status) status.textContent = '通信エラーが発生しました'
        blogTestRunBtn.disabled = false
      }
    })
  }
})
