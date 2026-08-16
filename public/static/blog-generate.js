// AI記事生成ページ: 生成には時間がかかる(画像認識+本文生成の2回のAI呼び出し)ため、
// 送信時にボタンを無効化し待機中であることを表示する(フォーム自体は通常のPOSTで送信する)。
document.addEventListener('DOMContentLoaded', () => {
  var form = document.querySelector('form[action="/blog/generate"]')
  var btn = document.getElementById('blog-generate-btn')
  var status = document.getElementById('blog-generate-status')
  if (!form || !btn) return

  form.addEventListener('submit', function () {
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...'
    if (status) status.textContent = '画像を解析し、記事を生成しています(30秒程度かかることがあります)...'
  })
})
