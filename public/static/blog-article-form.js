// 記事編集ページ(/blog/articles/:id/edit)・新規作成ページ(/blog/articles/new)の
// AI再生成ボタン、フッター追加チェックボックス用JS
document.addEventListener('DOMContentLoaded', () => {
  // 画像ドロップゾーン: 選択したファイル名をラベルに表示(AI記事生成ページと同じUI)
  var imageInput = document.getElementById('article-image-input')
  var imageDropzoneLabel = document.getElementById('article-image-dropzone-label')
  if (imageInput && imageDropzoneLabel) {
    var imageDefaultLabel = imageDropzoneLabel.textContent
    imageInput.addEventListener('change', function () {
      var file = imageInput.files && imageInput.files[0]
      imageDropzoneLabel.textContent = file ? file.name : imageDefaultLabel
    })
  }

  // フッターを追加するチェックボックス: ON/OFFで本文欄末尾にフッター文言を挿入/削除。
  // 2026-08-21追記(ユーザー指定): 従来はcheckboxのchangeイベントでのみ本文欄を
  // 書き換えていたため、編集画面を開いた直後(フッター追加ONで保存済みの記事は、
  // DB上のbodyがフッター除去済みのため)はチェックがONなのに本文欄にフッターが
  // 表示されておらず、実際に投稿される内容と画面表示が食い違って見えていた。
  // ページ読み込み時にも現在のチェック状態に合わせて本文欄を同期する。
  var footerCheckbox = document.getElementById('footer-enabled-checkbox')
  var bodyTextarea = document.getElementById('article-body-textarea')
  var footerText = footerCheckbox ? footerCheckbox.getAttribute('data-footer-text') || '' : ''

  function isFooterAtEnd() {
    if (!footerText) return { present: false, idx: -1 }
    var idx = bodyTextarea.value.lastIndexOf(footerText)
    var present = idx !== -1 && bodyTextarea.value.slice(idx + footerText.length).trim() === ''
    return { present: present, idx: idx }
  }

  function syncFooterInBody() {
    if (!footerCheckbox || !bodyTextarea || !footerText) return
    var state = isFooterAtEnd()
    if (footerCheckbox.checked) {
      if (!state.present) {
        bodyTextarea.value = bodyTextarea.value.replace(/\s+$/, '') + '\n\n' + footerText
      }
    } else if (state.present) {
      bodyTextarea.value = bodyTextarea.value.slice(0, state.idx).replace(/\s+$/, '')
    }
  }

  // 本文欄からフッター部分を除いた、実際にユーザーが書いた内容だけを取り出す
  // (必須項目チェックで「フッターしか無い空の本文」を通過させないため)。
  function getBodyWithoutFooter() {
    if (!bodyTextarea) return ''
    if (footerCheckbox && footerCheckbox.checked && footerText) {
      var state = isFooterAtEnd()
      if (state.present) return bodyTextarea.value.slice(0, state.idx)
    }
    return bodyTextarea.value
  }

  if (footerCheckbox && bodyTextarea) {
    footerCheckbox.addEventListener('change', function () {
      syncFooterInBody()
      validateArticleForm()
    })
    syncFooterInBody()
  }

  // 2026-08-21追記(ユーザー指定): 必須項目(タイトル・本文・HPBブログカテゴリ)が
  // 未設定のまま、または本文がフッター込みで950文字を超えたまま「投稿一覧に
  // 追加」/「保存する」を押せないようにする。未設定の項目は赤く表示する。
  var BODY_MAX_CHARS = 950
  var titleInput = document.getElementById('article-title-input')
  var titleLabel = document.getElementById('article-title-label')
  var bodyLabel = document.getElementById('article-body-label')
  var bodyCharCount = document.getElementById('article-body-charcount')
  var categorySelect = document.getElementById('article-category-select')
  var categoryLabel = document.getElementById('article-category-label')
  var submitBtn = document.getElementById('article-submit-btn')
  var requiredErrorEl = document.getElementById('article-required-error')
  var charLimitErrorEl = document.getElementById('article-charlimit-error')

  function setLabelInvalid(label, invalid) {
    if (!label) return
    label.classList.toggle('text-red-600', invalid)
    label.classList.toggle('text-gray-700', !invalid)
  }

  function validateArticleForm() {
    if (!bodyTextarea || !submitBtn) return

    var titleMissing = !!titleInput && titleInput.value.trim() === ''
    var bodyMissing = getBodyWithoutFooter().trim() === ''
    var categoryMissing = !!categorySelect && categorySelect.value === ''
    var requiredMissing = titleMissing || bodyMissing || categoryMissing

    setLabelInvalid(titleLabel, titleMissing)
    setLabelInvalid(bodyLabel, bodyMissing)
    setLabelInvalid(categoryLabel, categoryMissing)

    var charCount = bodyTextarea.value.length
    var overLimit = charCount > BODY_MAX_CHARS
    if (bodyCharCount) {
      bodyCharCount.textContent = charCount + ' / ' + BODY_MAX_CHARS + '文字'
      bodyCharCount.classList.toggle('text-red-600', overLimit)
      bodyCharCount.classList.toggle('text-gray-400', !overLimit)
    }

    if (requiredErrorEl) requiredErrorEl.classList.toggle('hidden', !requiredMissing)
    if (charLimitErrorEl) charLimitErrorEl.classList.toggle('hidden', !overLimit)
    submitBtn.disabled = requiredMissing || overLimit
  }

  if (bodyTextarea) {
    bodyTextarea.addEventListener('input', validateArticleForm)
    if (titleInput) titleInput.addEventListener('input', validateArticleForm)
    if (categorySelect) categorySelect.addEventListener('change', validateArticleForm)
    validateArticleForm()
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
          syncFooterInBody()
          validateArticleForm()
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
