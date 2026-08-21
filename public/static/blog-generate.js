// AI記事生成ページ: 生成には時間がかかる(画像認識+本文生成の2回のAI呼び出し)ため、
// 送信時にボタンを無効化し待機中であることを表示する(フォーム自体は通常のPOSTで送信する)。
document.addEventListener('DOMContentLoaded', () => {
  var form = document.querySelector('form[action="/blog/generate"]')
  var btn = document.getElementById('blog-generate-btn')
  var status = document.getElementById('blog-generate-status')

  var imageInput = document.getElementById('blog-generate-image-input')
  var dropzoneLabel = document.getElementById('blog-generate-dropzone-label')
  var dropzoneIcon = document.getElementById('blog-generate-dropzone-icon')
  var previewImg = document.getElementById('blog-generate-preview')
  if (imageInput && dropzoneLabel) {
    imageInput.addEventListener('change', function () {
      var file = imageInput.files && imageInput.files[0]
      dropzoneLabel.textContent = file ? file.name : 'タップして画像を選択'
      // 2026-08-21追記(ユーザー指定): 画像を選択し終えたら、その場でプレビュー表示する
      if (file && previewImg) {
        var reader = new FileReader()
        reader.onload = function (e) {
          previewImg.src = e.target.result
          previewImg.classList.remove('hidden')
          if (dropzoneIcon) dropzoneIcon.classList.add('hidden')
        }
        reader.readAsDataURL(file)
      } else if (previewImg) {
        previewImg.classList.add('hidden')
        previewImg.removeAttribute('src')
        if (dropzoneIcon) dropzoneIcon.classList.remove('hidden')
      }
    })
  }

  if (!form || !btn) return

  form.addEventListener('submit', function () {
    btn.disabled = true
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...'
    if (status) status.textContent = '画像を解析し、記事を生成しています(30秒程度かかることがあります)...'
  })
})
