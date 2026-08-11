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
    // 店名: 検索語ハイライト(span.highlightFw)を除いた本体テキスト
    const $clone = $a.clone()
    $clone.find('span.highlightFw').remove()
    const name = ($clone.text() || $a.text()).replace(/\s+/g, ' ').trim()
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
