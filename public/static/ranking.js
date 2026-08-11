// 検索順位計測「計測」画面のクライアント処理
// - 大/中/小エリアのカスケード(選択に応じて次の階層をAJAXで取得)
// - 「計測」ボタン(バックグラウンド計測を起動し、数秒後に自動更新)

;(function () {
  var serviceSel = document.getElementById('service-area')
  var middleSel = document.getElementById('middle-area')
  var smallSel = document.getElementById('small-area')
  var areaLabelInput = document.getElementById('area-label')

  function selectedText(sel) {
    if (!sel || sel.selectedIndex < 0) return ''
    var opt = sel.options[sel.selectedIndex]
    return opt && opt.value ? opt.text : ''
  }

  function updateAreaLabel() {
    var parts = [selectedText(serviceSel), selectedText(middleSel), selectedText(smallSel)].filter(function (t) {
      return t
    })
    if (areaLabelInput) areaLabelInput.value = parts.join(' > ')
  }

  function fillSelect(sel, options, placeholder) {
    sel.innerHTML = ''
    var ph = document.createElement('option')
    ph.value = ''
    ph.text = placeholder
    sel.appendChild(ph)
    options.forEach(function (o) {
      var el = document.createElement('option')
      el.value = o.code
      el.text = o.name
      sel.appendChild(el)
    })
  }

  async function loadAreas(level, service, middle) {
    var url = '/ranking/api/areas?level=' + level + '&service=' + encodeURIComponent(service)
    if (middle) url += '&middle=' + encodeURIComponent(middle)
    var res = await fetch(url)
    var data = await res.json()
    return data.options || []
  }

  if (serviceSel) {
    serviceSel.addEventListener('change', async function () {
      fillSelect(middleSel, [], '選択してください')
      fillSelect(smallSel, [], '選択してください（任意）')
      updateAreaLabel()
      if (!serviceSel.value) return
      middleSel.disabled = true
      var prev = middleSel.options[0]
      if (prev) prev.text = '読み込み中...'
      try {
        var options = await loadAreas('middle', serviceSel.value, '')
        fillSelect(middleSel, options, '選択してください')
      } catch (e) {
        fillSelect(middleSel, [], '取得に失敗しました')
      } finally {
        middleSel.disabled = false
        updateAreaLabel()
      }
    })
  }

  if (middleSel) {
    middleSel.addEventListener('change', async function () {
      fillSelect(smallSel, [], '選択してください（任意）')
      updateAreaLabel()
      if (!serviceSel.value || !middleSel.value) return
      smallSel.disabled = true
      try {
        var options = await loadAreas('small', serviceSel.value, middleSel.value)
        fillSelect(smallSel, options, options.length ? '選択してください（任意）' : '小エリアなし（任意）')
      } catch (e) {
        fillSelect(smallSel, [], '選択してください（任意）')
      } finally {
        smallSel.disabled = false
        updateAreaLabel()
      }
    })
  }

  if (smallSel) {
    smallSel.addEventListener('change', updateAreaLabel)
  }

  // 「計測」ボタン
  var measureBtn = document.getElementById('measure-btn')
  var status = document.getElementById('measure-status')
  if (measureBtn) {
    measureBtn.addEventListener('click', async function () {
      var salon = (document.querySelector('[name="salon"]') || {}).value || ''
      var service = serviceSel ? serviceSel.value : ''
      if (!salon || !service) {
        status.textContent = 'サロン名と大エリアを選択してください'
        return
      }
      var keywords = []
      for (var i = 0; i < 10; i++) {
        var el = document.getElementById('keyword_' + i)
        if (el && el.value.trim()) keywords.push(el.value.trim())
      }
      if (keywords.length === 0) {
        status.textContent = 'キーワードを1つ以上入力してください'
        return
      }
      updateAreaLabel()

      measureBtn.disabled = true
      status.textContent = '計測を開始しています...'
      try {
        var res = await fetch('/ranking/measure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            salon: salon,
            service_area_cd: service,
            middle_area_cd: middleSel ? middleSel.value : '',
            small_area_cd: smallSel ? smallSel.value : '',
            area_label: areaLabelInput ? areaLabelInput.value : '',
            keywords: keywords
          })
        })
        var data = await res.json()
        if (data.success) {
          status.textContent =
            '計測を開始しました（' + data.count + '件）。完了まで少し時間がかかります。まもなく自動更新します...'
          setTimeout(function () {
            location.reload()
          }, 4000)
        } else {
          status.textContent = 'エラー: ' + (data.error || '不明なエラー')
          measureBtn.disabled = false
        }
      } catch (e) {
        status.textContent = '通信エラーが発生しました'
        measureBtn.disabled = false
      }
    })
  }
})()
