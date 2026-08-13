// ============================================
// ranking-parse.ts
// HPB検索結果ページのHTMLから「該当数」と「サロン掲載順位」を抽出する
// 純粋関数群。ネットワークI/Oは持たない(fetch/取得は ranking-scraper.ts 側)。
//
// ローカルのPythonスクリプト(Hpb_seo_rank_kuchikomiV2.0.py)のDOM判定を
// 忠実に移植しつつ、実データで判明した1点を改善している:
//   Pythonは .slnName をDOM順で全件数えて順位を出していたが、検索結果には
//   cstt(掲載順位カウンタ)を持たない PR/広告枠 が1件差し込まれることがある。
//   その枠をDOM順に数えると以降の順位が実際より下にズレるため、本実装では
//   「cstt を持つオーガニック枠だけ」を数えて順位を算出する。
// ============================================

import * as cheerio from 'cheerio'

export type SalonCassette = {
  /** cstt(掲載順位カウンタ)。PR/広告枠など持たない場合は null */
  cstt: number | null
  /** サロンID(slnH...)。href から抽出 */
  slnId: string | null
  /** 店名(検索ハイライト span.highlightFw は除外済み) */
  name: string
}

export type ParsedSearchPage = {
  /** 該当数(.numberOfResult)。取得できなければ null */
  resultCount: number | null
  cassettes: SalonCassette[]
  /** 次ページ(.arrowPagingR)が存在するか */
  hasNextPage: boolean
}

export type RankMatch = {
  /** 全ページ通しの順位(オーガニック枠のみで計算) */
  rank: number
  page: number
  slnId: string | null
  matchedName: string
}

/**
 * 全角→半角(NFKC)正規化 + 空白/記号除去。Pythonの _norm() を移植。
 * 店名の表記ゆれを吸収して部分一致判定するために使う。
 */
export function normalizeSalonName(s: string): string {
  if (!s) return ''
  let t = s.normalize('NFKC')
  // 空白(全角含む)・各種括弧・区切り記号を除去
  t = t.replace(/[\s　[\]（）()【】「」『』/|｜・〜\-–—_]+/g, '')
  return t
}

/** 検索結果ページ1枚分をパースする */
export function parseSearchResultPage(html: string): ParsedSearchPage {
  const $ = cheerio.load(html)

  // 該当数
  const countText = $('.numberOfResult').first().text().replace(/[,\s]/g, '')
  const cm = countText.match(/\d+/)
  const resultCount = cm ? parseInt(cm[0], 10) : null

  // サロン枠: ヘアは h3.slnName、エステ/ネイル等は h3.slcHead(>a)
  let els = $('h3.slnName')
  if (els.length === 0) els = $('h3.slcHead')
  if (els.length === 0) els = $('.slcHead')

  const cassettes: SalonCassette[] = []
  els.each((_, el) => {
    const $el = $(el)
    const $a = $el.is('a') ? $el : $el.find('a').first()
    const href = $a.attr('href') || ''
    const slnMatch = href.match(/slnH\d+/)
    const csttMatch = href.match(/cstt=(\d+)/)
    // 店名: リンクのテキストをそのまま使う。
    // 2026-08-13修正(重大バグ): 以前はHPBの検索語ハイライト(span.highlightFw)
    // を丸ごとDOMから除去してからテキストを取っていたが、これは表示上の
    // 強調用spanで囲っているだけであり、除去するとその部分の文字列自体が
    // 消えてしまう。対策サロン名(salon_name)に検索キーワードそのものが
    // 含まれるケース(例: 店名に「ブリーチ」を含むサロンで「ブリーチ」を
    // 検索)では、HPB側がその一致箇所をhighlightFwで囲むため、除去すると
    // 店名からその単語が欠落し、部分一致判定が常に失敗して圏外誤判定になる
    // (実際は該当サロンが上位に掲載されていても圏外と表示される)重大な
    // バグがあった。spanで囲われていても.text()は中のテキストを問題なく
    // 拾うため、除去処理自体が不要かつ有害だった。
    const name = $a.text().replace(/\s+/g, ' ').trim()
    cassettes.push({
      cstt: csttMatch ? parseInt(csttMatch[1], 10) : null,
      slnId: slnMatch ? slnMatch[0] : null,
      name
    })
  })

  return {
    resultCount,
    cassettes,
    hasNextPage: $('.arrowPagingR').length > 0
  }
}

// --------------------------------------------
// サロン自身のHPB公開ページ(https://beauty.hotpepper.jp/sln{STORE_ID}/)から、
// そのサロンが属する中/小エリアを読み取る。
// 対策エリアはSalonMotion上で手動選択するのではなく、この自動検出値を使う。
// --------------------------------------------

export type SalonAreaInfo = {
  serviceAreaCd: string | null
  middleAreaCd: string | null
  middleAreaName: string | null
  smallAreaCd: string | null
  smallAreaName: string | null
}

// 中エリアへのリンクは `/svc{SA}/mac{XX}/` 形式(末尾に /salon/ は付かない)
const MIDDLE_AREA_HREF_RE = /^(?:https?:\/\/beauty\.hotpepper\.jp)?\/svc([A-Za-z0-9]+)\/mac([A-Za-z0-9]+)\/(?:\?[^"'#]*)?$/
// 小エリアへのリンクは `/svc{SA}/mac{XX}/salon/sac{YY}/` 形式
const SMALL_AREA_HREF_RE =
  /^(?:https?:\/\/beauty\.hotpepper\.jp)?\/svc([A-Za-z0-9]+)\/mac([A-Za-z0-9]+)\/salon\/sac([A-Za-z0-9]+)\/(?:\?[^"'#]*)?$/

/**
 * サロンページのHTMLから、ページ上に掲載されている中エリア/小エリアへの
 * リンク(href)とその表示名を1つずつ抽出する(最初に見つかったものを採用)。
 */
export function extractSalonAreaFromSlnPage(html: string): SalonAreaInfo {
  const $ = cheerio.load(html)
  let serviceAreaCd: string | null = null
  let middleAreaCd: string | null = null
  let middleAreaName: string | null = null
  let smallAreaCd: string | null = null
  let smallAreaName: string | null = null

  $('a[href]').each((_, el) => {
    if (middleAreaCd && smallAreaCd) return false
    const href = ($(el).attr('href') || '').trim()
    if (!smallAreaCd) {
      const m = href.match(SMALL_AREA_HREF_RE)
      if (m) {
        const $el = $(el)
        $el.find('br').replaceWith(' ')
        const name = $el.text().replace(/\s+/g, ' ').trim()
        if (name) {
          serviceAreaCd = serviceAreaCd || m[1]
          smallAreaCd = m[3]
          smallAreaName = name
          return
        }
      }
    }
    if (!middleAreaCd) {
      const m = href.match(MIDDLE_AREA_HREF_RE)
      if (m) {
        const $el = $(el)
        $el.find('br').replaceWith(' ')
        const name = $el.text().replace(/\s+/g, ' ').trim()
        if (name) {
          serviceAreaCd = serviceAreaCd || m[1]
          middleAreaCd = m[2]
          middleAreaName = name
        }
      }
    }
  })

  return { serviceAreaCd, middleAreaCd, middleAreaName, smallAreaCd, smallAreaName }
}

/**
 * 1ページ分のHTMLから、対象サロンの順位を探す。
 * - オーガニック枠(cstt有り)だけを数えるので PR/広告枠でズレない
 * - 店名は正規化して部分一致(Python同様)
 * @param page このHTMLのページ番号(1始まり)
 * @param perPage 1ページの掲載件数(HPBは20)
 */
export function findSalonRankInPage(
  html: string,
  salonName: string,
  page: number,
  perPage = 20
): RankMatch | null {
  const parsed = parseSearchResultPage(html)
  const target = normalizeSalonName(salonName)
  if (!target) return null

  let organicIndex = 0
  for (const c of parsed.cassettes) {
    if (c.cstt == null) continue // PR/広告枠はスキップ
    organicIndex += 1
    if (normalizeSalonName(c.name).includes(target)) {
      return {
        rank: organicIndex + perPage * (page - 1),
        page,
        slnId: c.slnId,
        matchedName: c.name
      }
    }
  }
  return null
}
