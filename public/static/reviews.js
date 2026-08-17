// 口コミ管理ツール(口コミ評価推移・スタイリスト別評価)の操作用JS。
// グラフはライブラリを使わず手書きSVGで描画する(このアプリは他ページも
// ビルドレス・追加依存なしの方針のため)。
document.addEventListener('DOMContentLoaded', () => {
  const PINK = '#ec4899'
  const PINK_DARK = '#db2777'
  const GRID = '#e5e7eb'
  const AXIS_TEXT = '#9ca3af'

  function readJsonData(id) {
    const el = document.getElementById(id)
    if (!el) return null
    try {
      return JSON.parse(el.textContent || 'null')
    } catch (e) {
      return null
    }
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]))
    return el
  }

  // ---------- 共通: ホバーツールチップ ----------
  function createTooltip(container) {
    const tip = document.createElement('div')
    tip.className =
      'pointer-events-none absolute z-10 hidden rounded-lg bg-gray-900 text-white text-xs px-2.5 py-1.5 shadow-lg whitespace-nowrap'
    container.style.position = 'relative'
    container.appendChild(tip)
    return {
      show(x, y, html) {
        tip.innerHTML = html
        tip.style.left = x + 'px'
        tip.style.top = y + 'px'
        tip.style.transform = 'translate(-50%, -100%) translateY(-8px)'
        tip.classList.remove('hidden')
      },
      hide() {
        tip.classList.add('hidden')
      }
    }
  }

  // ---------- ①口コミ評価(折れ線グラフ) ----------
  // 2026-08-18追記(ユーザー指定): 計測件数によってデザインを変える。
  //   1件のみ: 折れ線グラフにする意味が無い(点1つだけの寂しい見た目に
  //     なっていた)ため、大きな数字で見せる「統計タイル」表示にする。
  //   2件以上: 折れ線グラフ。ただし従来は固定viewBox(720x140)を
  //     w-full/h-autoでCSS縮小表示していたため、スマホ幅では文字・点まで
  //     一律に縮小され、著しく読みにくくなっていた(ユーザー報告)。
  //     実際のコンテナ幅を都度測ってviewBoxに使うことで、SVG内の
  //     font-size/線幅がそのまま実寸ピクセルに対応するようにし、
  //     画面幅に関わらず可読性を保つ。
  function renderSinglePointStat(container, p) {
    container.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.className = 'flex flex-col items-center justify-center gap-1 py-6 text-center'
    const dateEl = document.createElement('p')
    dateEl.className = 'text-xs text-gray-400'
    dateEl.textContent = p.date + ' 時点'
    const valueWrap = document.createElement('div')
    valueWrap.className = 'flex items-baseline gap-2'
    valueWrap.innerHTML =
      '<i class="fas fa-star text-amber-400 text-2xl"></i>' +
      '<span class="text-5xl font-bold text-gray-800">' + p.avgOverall.toFixed(2) + '</span>'
    const countEl = document.createElement('p')
    countEl.className = 'text-xs text-gray-400'
    countEl.textContent = p.count + '件の口コミ'
    const noteEl = document.createElement('p')
    noteEl.className = 'text-xs text-gray-400 mt-3'
    noteEl.textContent = '次回以降の計測結果がたまると、ここに推移グラフが表示されます'
    wrap.appendChild(dateEl)
    wrap.appendChild(valueWrap)
    wrap.appendChild(countEl)
    wrap.appendChild(noteEl)
    container.appendChild(wrap)
  }

  function renderLineChart(container, points) {
    // コンテナの実際の表示幅をSVG座標系にそのまま使う(px≒座標単位)。
    // 極端に狭い場合(初回描画タイミング等)は最低幅を確保する。
    const width = Math.max(260, Math.round(container.getBoundingClientRect().width) || 320)
    // 横幅に対して縦横比を可変にし、スマホの狭い幅でも点が詰まりすぎず、
    // かつ広い画面で間延びしすぎないようにする。
    const height = Math.max(130, Math.min(220, Math.round(width * 0.34)))
    const padL = 34
    const padR = 14
    const padT = 14
    const padB = 22
    const plotW = width - padL - padR
    const plotH = height - padT - padB

    // サロンの口コミ評価は実質4.5〜5.0付近に集中するため、その範囲を
    // 0.1刻みで表示することで変化を見やすくする(1〜5の全域表示はしない)。
    const yMin = 4.5
    const yMax = 5.0
    const xStep = points.length > 1 ? plotW / (points.length - 1) : 0

    const xOf = (i) => padL + i * xStep
    const yOf = (v) => padT + plotH * (1 - (v - yMin) / (yMax - yMin))

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: height,
      role: 'img',
      'aria-label': '口コミ評価の推移'
    })

    // グリッド線(recessive、控えめなグレー)+ Y軸ラベル(4.5〜5.0、0.1刻み)
    for (let i = 0; i <= 5; i++) {
      const v = Math.round((yMin + i * 0.1) * 10) / 10
      const y = yOf(v)
      svg.appendChild(svgEl('line', { x1: padL, x2: width - padR, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }))
      const label = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: AXIS_TEXT })
      label.textContent = v.toFixed(1)
      svg.appendChild(label)
    }

    // X軸ラベル(狭い幅では間引く数を増やして重なりを防ぐ)
    const maxLabels = Math.max(2, Math.floor(plotW / 45))
    const labelEvery = Math.max(1, Math.ceil(points.length / maxLabels))
    points.forEach((p, i) => {
      if (i % labelEvery !== 0 && i !== points.length - 1) return
      const label = svgEl('text', {
        x: xOf(i),
        y: height - padB + 14,
        'text-anchor': 'middle',
        'font-size': 9,
        fill: AXIS_TEXT
      })
      label.textContent = p.date.slice(2).replace(/-/g, '/')
      svg.appendChild(label)
    })

    // 折れ線(2px、pink)
    const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(i)} ${yOf(p.avgOverall)}`).join(' ')
    svg.appendChild(svgEl('path', { d: pathD, fill: 'none', stroke: PINK, 'stroke-width': 2, 'stroke-linecap': 'round' }))

    const tooltip = createTooltip(container)

    points.forEach((p, i) => {
      const cx = xOf(i)
      const cy = yOf(p.avgOverall)
      // 可視マーカー(小さめ)+ ホバー用の当たり判定(見た目より大きい透明円、8px以上)
      svg.appendChild(svgEl('circle', { cx, cy, r: 3.5, fill: PINK_DARK, stroke: 'white', 'stroke-width': 1.5 }))
      const hitCircle = svgEl('circle', { cx, cy, r: 10, fill: 'transparent', style: 'cursor:pointer' })
      hitCircle.addEventListener('mouseenter', () => {
        tooltip.show(cx, cy, `${p.date}<br>平均 <b>${p.avgOverall.toFixed(2)}</b>(${p.count}件)`)
      })
      hitCircle.addEventListener('mouseleave', tooltip.hide)
      svg.appendChild(hitCircle)
    })

    container.innerHTML = ''
    container.appendChild(svg)
  }

  function renderTrendChart() {
    const container = document.getElementById('review-trend-chart')
    const data = readJsonData('review-trend-data')
    if (!container || !data || !data.trend || data.trend.length === 0) return

    const points = data.trend
    if (points.length === 1) {
      renderSinglePointStat(container, points[0])
      return
    }
    renderLineChart(container, points)
  }

  // ウィンドウ幅が変わった場合(端末回転・PCウィンドウのリサイズ等)、
  // グラフをコンテナの新しい実寸幅で再描画する(簡易デバウンス)。
  let resizeTimer = null
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(renderTrendChart, 200)
  })

  // ②スタイリスト別評価はSSRのカード一覧で表示するため、JSでの描画は不要になった。

  renderTrendChart()

  // ---------- 初回取り込み・同期の開始/進捗ポーリング ----------
  const startBtn = document.getElementById('review-sync-start-btn')
  const statusText = document.getElementById('review-sync-status-text')
  let pollTimer = null

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function describeStatus(data) {
    if (!data || data.status === 'none') return ''
    if (data.status === 'pending' || data.status === 'running') return '同期処理中です(通常1〜2分程度で完了します)…'
    if (data.status === 'success') {
      return `同期が完了しました(突合成功 ${data.matchedCount}件 / 未突合 ${data.unmatchedCount}件)。画面を更新します…`
    }
    if (data.status === 'failed' || data.status === 'timeout') {
      return `同期に失敗しました: ${data.errorMessage || '不明なエラー'}`
    }
    return ''
  }

  async function pollStatus() {
    try {
      const res = await fetch('/api/reviews/sync/status')
      const data = await res.json()
      if (statusText) statusText.textContent = describeStatus(data)
      if (data.status === 'success') {
        stopPolling()
        setTimeout(() => location.reload(), 1200)
      } else if (data.status === 'failed' || data.status === 'timeout') {
        stopPolling()
        if (startBtn) startBtn.disabled = false
      }
    } catch (e) {
      // 一時的な通信エラーはポーリング継続(次回成功すれば復帰する)
    }
  }

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true
      if (statusText) statusText.textContent = '同期ジョブを投入中...'
      try {
        const res = await fetch('/api/reviews/sync/start', { method: 'POST' })
        const data = await res.json()
        if (!data.success) {
          if (statusText) statusText.textContent = 'エラー: ' + (data.error || '不明なエラー')
          startBtn.disabled = false
          return
        }
        pollStatus()
        pollTimer = setInterval(pollStatus, 4000)
      } catch (e) {
        if (statusText) statusText.textContent = '通信エラーが発生しました'
        startBtn.disabled = false
      }
    })

    // ページを開いた時点で既に処理中のジョブがあれば、ボタンを無効化して
    // ポーリングを再開する(実行中に別タブ/再訪した場合のケア)。
    fetch('/api/reviews/sync/status')
      .then((res) => res.json())
      .then((data) => {
        if (data.status === 'pending' || data.status === 'running') {
          startBtn.disabled = true
          if (statusText) statusText.textContent = describeStatus(data)
          pollTimer = setInterval(pollStatus, 4000)
        }
      })
      .catch(() => {})
  }

  // ---------- ③口コミ一覧: AI下書き生成・手動返信投稿 ----------
  const listContainer = document.getElementById('review-list-container')
  if (listContainer) {
    listContainer.addEventListener('click', async (e) => {
      const openBtn = e.target.closest('.review-reply-open-btn')
      const generateBtn = e.target.closest('.review-reply-generate-btn')
      const sendBtn = e.target.closest('.review-reply-send-btn')

      if (openBtn) {
        const reviewId = openBtn.dataset.reviewId
        const form = listContainer.querySelector(`.review-reply-form[data-review-id="${reviewId}"]`)
        if (form) {
          form.classList.remove('hidden')
          const textarea = form.querySelector('.review-reply-textarea')
          // 表示直後はautosize-textarea.js側のscrollHeight計算がまだ効いて
          // いない(直前までdisplay:noneだったため)ため、ここで明示的に
          // 高さを再計算させる。
          if (textarea) {
            textarea.style.height = 'auto'
            textarea.style.height = textarea.scrollHeight + 'px'
            textarea.focus()
          }
        }
        openBtn.classList.add('hidden')
        return
      }

      if (generateBtn) {
        const reviewId = generateBtn.dataset.reviewId
        const textarea = listContainer.querySelector(`.review-reply-textarea[data-review-id="${reviewId}"]`)
        const statusEl = listContainer.querySelector(`.review-reply-status[data-review-id="${reviewId}"]`)
        generateBtn.disabled = true
        if (statusEl) statusEl.textContent = 'AIが返信文を作成中...'
        try {
          const res = await fetch(`/api/reviews/${reviewId}/generate-reply`, { method: 'POST' })
          const data = await res.json()
          if (!data.success) {
            if (statusEl) statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
          } else {
            if (textarea) textarea.value = data.reply
            if (statusEl) statusEl.textContent = '下書きを生成しました。内容を確認・修正してから返信してください'
          }
        } catch (err) {
          if (statusEl) statusEl.textContent = '通信エラーが発生しました'
        } finally {
          generateBtn.disabled = false
        }
        return
      }

      if (sendBtn) {
        const reviewId = sendBtn.dataset.reviewId
        const textarea = listContainer.querySelector(`.review-reply-textarea[data-review-id="${reviewId}"]`)
        const statusEl = listContainer.querySelector(`.review-reply-status[data-review-id="${reviewId}"]`)
        const replyContent = textarea ? textarea.value.trim() : ''
        if (!replyContent) {
          if (statusEl) statusEl.textContent = '返信文を入力してください'
          return
        }
        if (!confirm('この内容でSALON BOARDへ返信を投稿します。よろしいですか？')) return
        sendBtn.disabled = true
        if (statusEl) statusEl.textContent = '返信を投稿中です...'
        try {
          const res = await fetch(`/api/reviews/${reviewId}/send-reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ replyContent })
          })
          const data = await res.json()
          if (!data.success) {
            if (statusEl) statusEl.textContent = 'エラー: ' + (data.error || '不明なエラー')
            sendBtn.disabled = false
          } else {
            if (statusEl) statusEl.textContent = '返信処理を開始しました。完了まで少し時間がかかります(画面を更新して確認してください)'
          }
        } catch (err) {
          if (statusEl) statusEl.textContent = '通信エラーが発生しました'
          sendBtn.disabled = false
        }
      }
    })
  }
})
