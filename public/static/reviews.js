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

  // ---------- ①口コミ評価推移(折れ線グラフ) ----------
  function renderTrendChart() {
    const container = document.getElementById('review-trend-chart')
    const data = readJsonData('review-trend-data')
    if (!container || !data || !data.trend || data.trend.length === 0) return

    const points = data.trend
    const width = 720
    const height = 260
    const padL = 36
    const padR = 16
    const padT = 16
    const padB = 32
    const plotW = width - padL - padR
    const plotH = height - padT - padB

    const yMin = 1
    const yMax = 5
    const xStep = points.length > 1 ? plotW / (points.length - 1) : 0

    const xOf = (i) => padL + i * xStep
    const yOf = (v) => padT + plotH * (1 - (v - yMin) / (yMax - yMin))

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'w-full h-auto',
      role: 'img',
      'aria-label': '口コミ評価の月次推移'
    })

    // グリッド線(recessive、控えめなグレー)+ Y軸ラベル(1〜5)
    for (let v = yMin; v <= yMax; v++) {
      const y = yOf(v)
      svg.appendChild(svgEl('line', { x1: padL, x2: width - padR, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }))
      const label = svgEl('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: AXIS_TEXT })
      label.textContent = String(v)
      svg.appendChild(label)
    }

    // X軸ラベル(件数が多い場合は間引く。2〜3ヶ月おき程度を目安に)
    const labelEvery = Math.max(1, Math.ceil(points.length / 8))
    points.forEach((p, i) => {
      if (i % labelEvery !== 0 && i !== points.length - 1) return
      const label = svgEl('text', {
        x: xOf(i),
        y: height - padB + 18,
        'text-anchor': 'middle',
        'font-size': 10,
        fill: AXIS_TEXT
      })
      label.textContent = p.month.slice(2).replace('-', '/')
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
        tooltip.show(cx, cy, `${p.month}<br>平均 <b>${p.avgOverall.toFixed(2)}</b>(${p.count}件)`)
      })
      hitCircle.addEventListener('mouseleave', tooltip.hide)
      svg.appendChild(hitCircle)
    })

    container.innerHTML = ''
    container.appendChild(svg)
  }

  // ---------- ②スタイリスト別評価(横棒グラフ) ----------
  function renderStylistChart() {
    const container = document.getElementById('review-stylist-chart')
    const data = readJsonData('review-stylist-data')
    if (!container || !data || !data.stylists || data.stylists.length === 0) return

    const stylists = data.stylists
    const rowHeight = 34
    const width = 720
    const MAX_NAME_CHARS = 8
    const padL = 156
    const padR = 92
    const padTop = 8
    const height = padTop * 2 + rowHeight * stylists.length
    const plotW = width - padL - padR

    const xMax = 5
    const xOf = (v) => padL + (plotW * v) / xMax

    const svg = svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`,
      class: 'w-full h-auto',
      role: 'img',
      'aria-label': 'スタイリスト別の総合評価平均'
    })

    const tooltip = createTooltip(container)

    stylists.forEach((s, i) => {
      const y = padTop + i * rowHeight
      const barH = 18
      const barY = y + (rowHeight - barH) / 2
      const barW = Math.max(0, xOf(s.avgOverall) - padL)
      const rawName = s.stylistName || ''
      const displayName = rawName.length > MAX_NAME_CHARS ? rawName.slice(0, MAX_NAME_CHARS) + '…' : rawName

      const showTooltip = (target) => {
        const rect = container.getBoundingClientRect()
        const cx = target.getBoundingClientRect()
        tooltip.show(
          cx.right - rect.left - (cx.width || 0) / 2,
          barY,
          `<b>${s.stylistName}</b><br>総合 ${s.avgOverall.toFixed(2)}(${s.count}件)<br>` +
            `雰囲気 ${s.avgAtmosphere.toFixed(2)} / 接客 ${s.avgService.toFixed(2)} / 技術 ${s.avgTechnique.toFixed(2)} / メニュー・料金 ${s.avgMenuPrice.toFixed(2)}`
        )
      }

      const nameLabel = svgEl('text', {
        x: padL - 10,
        y: y + rowHeight / 2 + 4,
        'text-anchor': 'end',
        'font-size': 12,
        fill: '#374151',
        style: rawName.length > MAX_NAME_CHARS ? 'cursor:default' : ''
      })
      nameLabel.textContent = displayName
      if (rawName.length > MAX_NAME_CHARS) {
        nameLabel.addEventListener('mouseenter', (e) => showTooltip(e.target))
        nameLabel.addEventListener('mouseleave', tooltip.hide)
      }
      svg.appendChild(nameLabel)

      // 背景トラック(2pxのサーフェス区切りを意識し、バー本体とは別要素にする)
      svg.appendChild(
        svgEl('rect', { x: padL, y: barY, width: plotW, height: barH, rx: 4, fill: '#f3f4f6' })
      )

      const bar = svgEl('rect', {
        x: padL,
        y: barY,
        width: barW,
        height: barH,
        rx: 4,
        fill: PINK,
        style: 'cursor:pointer'
      })
      bar.addEventListener('mouseenter', (e) => showTooltip(e.target))
      bar.addEventListener('mouseleave', tooltip.hide)
      svg.appendChild(bar)

      const valueLabel = svgEl('text', {
        x: xOf(s.avgOverall) + 8,
        y: y + rowHeight / 2 + 4,
        'font-size': 12,
        'font-weight': 'bold',
        fill: PINK_DARK
      })
      valueLabel.textContent = `${s.avgOverall.toFixed(2)}(${s.count}件)`
      svg.appendChild(valueLabel)
    })

    container.innerHTML = ''
    container.appendChild(svg)
  }

  renderTrendChart()
  renderStylistChart()

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
})
