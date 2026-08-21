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

// --------------------------------------------
// 口コミ管理ツール(2026-08-16追記): HPB公開口コミ一覧ページのパース
// --------------------------------------------

export type HpbReviewItem = {
  /** 投稿日を "YYYY-MM-DD" に正規化したもの。HPB表示は時刻を含まない(日付のみ) */
  postedDate: string
  nickname: string
  /** 例: "女性/40代/会社員"。無ければ空文字 */
  attribute: string
  content: string
  menuUsed: string
  couponUsed: string
  /** サロンからの返信文。無ければ null */
  salonReplyContent: string | null
  scoreOverall: number | null
  scoreAtmosphere: number | null
  scoreService: number | null
  scoreTechnique: number | null
  scoreMenuPrice: number | null
}

export type HpbReviewPageResult = {
  items: HpbReviewItem[]
  /** 次ページの絶対URL。無ければnull(最終ページ) */
  nextPageUrl: string | null
  /** ページ上部の「サロン平均」バッジの値(参考表示用)。1ページ目にのみ存在 */
  salonAverageScore: number | null
}

/** "2026/8/15" や "2026/08/15" を "2026-08-15" に正規化する */
function normalizeSlashDate(raw: string): string | null {
  const m = raw.match(/(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/)
  if (!m) return null
  const [, y, mo, d] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/**
 * ul.judgeList(総合+4軸の評点リスト)から、ラベル文字列をキーにスコアを
 * 取り出す。ラベルは各<li>から評点用span(.fgPink)と星アイコンを除いた
 * 残りのテキストで判定する(表示順に依存せず、ラベル文字列で確実に対応付ける)。
 */
function parseJudgeList($: cheerio.CheerioAPI, judgeListEl: any): Record<string, number> {
  const scores: Record<string, number> = {}
  $(judgeListEl)
    .find('li')
    .each((_, li) => {
      const $li = $(li)
      const scoreText = $li.find('span.fgPink').first().text().trim()
      const score = Number(scoreText)
      const $clone = $li.clone()
      $clone.find('span.fgPink, span.iconStarOn, span.iconStarOff').remove()
      const label = $clone.text().replace(/\s+/g, '').trim()
      if (label && Number.isFinite(score)) scores[label] = score
    })
  return scores
}

/**
 * HPB公開口コミ一覧ページ(https://beauty.hotpepper.jp/{hpbSlnId}/review/、
 * および2ページ目以降の .../review/PN{n}.html)1ページ分をパースする。
 * ログイン不要・担当スタイリスト名は含まれない(サロンボード側の一覧と
 * 投稿日+本文で突合する設計。詳細はreview-match.ts参照)。
 */
export function parseHpbReviewPage(html: string): HpbReviewPageResult {
  const $ = cheerio.load(html)

  const salonAverageText = $('.reviewRatingMeanScore').first().text().trim()
  const salonAverageScore = salonAverageText ? Number(salonAverageText) : null

  const items: HpbReviewItem[] = []
  $('li.reportCassette').each((_, li) => {
    const $li = $(li)
    const nickname = $li.find('.reportTitle span.b').first().text().trim()
    const attributeRaw = $li.find('.reportTitle span.fgGray').first().text().trim()
    const attribute = attributeRaw.replace(/[（）()]/g, '').replace(/\s+/g, '')

    const postedRaw = $li.find('.fr p.fs10.fgGray').first().text()
    const postedDate = normalizeSlashDate(postedRaw)
    if (!postedDate) return // 投稿日が取れない行はスキップ(構造想定外)

    const scores = parseJudgeList($, $li.find('ul.judgeList').get(0))

    // 本文: li内の最初のp.wwbwが口コミ本文。内部にネストされたdl.mT25
    // (クーポン・メニュー情報)は本文から除外して抽出する。2件目以降の
    // p.wwbwがあればサロン返信文(div.bdGrayの中)。
    const wwbwEls = $li.find('p.wwbw').toArray()
    let content = ''
    let menuUsed = ''
    let couponUsed = ''
    if (wwbwEls.length > 0) {
      const $body = $(wwbwEls[0]).clone()
      $body.find('br').replaceWith('\n')
      const $dl = $body.find('dl.mT25')
      couponUsed = $dl.find('dd p').first().text().replace(/\s+/g, ' ').trim()
      menuUsed = $dl
        .find('dd p.fs10')
        .first()
        .text()
        .replace(/\[施術メニュー\]/, '')
        .replace(/\s+/g, ' ')
        .trim()
      $dl.remove()
      content = $body.text().replace(/\n\s+/g, '\n').trim()
    }
    let salonReplyContent: string | null = null
    if (wwbwEls.length > 1) {
      const $reply = $(wwbwEls[1]).clone()
      $reply.find('br').replaceWith('\n')
      salonReplyContent = $reply.text().replace(/\n\s+/g, '\n').trim() || null
    }

    items.push({
      postedDate,
      nickname,
      attribute,
      content,
      menuUsed,
      couponUsed,
      salonReplyContent,
      scoreOverall: scores['総合'] ?? null,
      scoreAtmosphere: scores['雰囲気'] ?? null,
      scoreService: scores['接客サービス'] ?? null,
      scoreTechnique: scores['技術・仕上がり'] ?? null,
      scoreMenuPrice: scores['メニュー・料金'] ?? null
    })
  })

  const nextPageUrl = $('link[rel="next"]').attr('href') || null

  return { items, nextPageUrl, salonAverageScore }
}

// --------------------------------------------
// ブログ参考材料機能(2026-08-17追記): HPB公開サロンページからの
// キャッチ・コピー・からの一言(メッセージ)、および公開ブログ一覧の抜粋の抽出
// --------------------------------------------

export type SalonGenderPercentages = {
  ladies: number
  mens: number
  others: number
}

/** 年代比率(%)。5要素固定順: [〜10代, 20代, 30代, 40代, 50代〜]。データが無い年代はnull */
export type SalonAgePercentages = {
  ladies: (number | null)[]
  mens: (number | null)[]
  others: (number | null)[]
}

export type SalonHpbProfileInfo = {
  /** .shopCatchCopy */
  catchCopy: string | null
  /** .slnTopImgDescription */
  description: string | null
  /** 見出しに「からの一言」を含むセクションの本文(構造で辿るため、クラス名は
   *  サイト側の変更に多少強い。同じクラスが他の見出しにも使われているため
   *  テキスト内容で判定する) */
  message: string | null
  /** table.averageCostTbl > .jscAveragePriceFirstArea(初来店の平均予約金額) */
  avgPriceFirstVisit: string | null
  /** table.averageCostTbl > .jscAveragePriceSecondOnwardsArea(2回目以降来店の平均予約金額) */
  avgPriceRepeat: string | null
  /** #jsiSalonGraphData(ld+json)内のsalonGenderPercentages */
  genderRatio: SalonGenderPercentages | null
  /** #jsiSalonGraphData(ld+json)内のsalonAgePercentages */
  ageRatio: SalonAgePercentages | null
  /** 「〜の雰囲気」セクションの各写真キャプション(p.fgGray.fs10.mT10) */
  atmosphereCaptions: string[]
  /** 「〜のサロンデータ」テーブル(table.slnDataTbl)のラベル→値 */
  salonData: { label: string; value: string }[]
  /** サロントップの特集カルーセル(#jsiSpecialFeatureCarousel)。カテゴリ・見出し・説明文 */
  specials: { category: string; headline: string; description: string }[]
}

const AGE_RATIO_BUCKET_LABELS = ['〜10代', '20代', '30代', '40代', '50代〜']

/**
 * サロンの公開ページ(https://beauty.hotpepper.jp/sln{STORE_ID}/)から
 * キャッチコピー・紹介文・「からの一言」メッセージ・平均予約金額・来店者の
 * 性別/年代比率を抽出する。
 */
export function extractSalonProfileFromSlnPage(html: string): SalonHpbProfileInfo {
  const $ = cheerio.load(html)

  const catchCopy = $('.shopCatchCopy').first().text().replace(/\s+/g, ' ').trim() || null
  const description = $('.slnTopImgDescription').first().text().replace(/\s+/g, ' ').trim() || null

  let message: string | null = null
  $('h2').each((_, h2) => {
    const heading = $(h2).text().trim()
    if (!heading.includes('からの一言')) return
    // 見出しを含むdivの直後の兄弟要素(本文ブロック)の中にある<p>のうち、
    // 氏名・肩書きに続く最後の<p>がメッセージ本文(実HTMLで確認済みの構造)
    const container = $(h2).parent().next()
    const paragraphs = container.find('p')
    if (paragraphs.length > 0) {
      const text = $(paragraphs.get(paragraphs.length - 1))
        .text()
        .replace(/\s+/g, ' ')
        .trim()
      if (text) message = text
    }
    return false // 最初に一致したセクションのみ採用
  })

  const avgPriceFirstVisit = $('.jscAveragePriceFirstArea').first().text().replace(/\s+/g, ' ').trim() || null
  const avgPriceRepeat = $('.jscAveragePriceSecondOnwardsArea').first().text().replace(/\s+/g, ' ').trim() || null

  // 性別・年代比率は #jsiSalonGraphData(type="application/ld+json") に
  // サーバーサイドでそのまま埋め込まれている(表示側の<span>はJSで穴埋めされる
  // 空要素のため、DOMテキストからは取得できない)。
  let genderRatio: SalonGenderPercentages | null = null
  let ageRatio: SalonAgePercentages | null = null
  const graphDataText = $('#jsiSalonGraphData').first().text().trim()
  if (graphDataText) {
    try {
      const parsed = JSON.parse(graphDataText)
      const g = parsed?.salonGenderPercentages
      if (g && typeof g.ladies === 'number' && typeof g.mens === 'number' && typeof g.others === 'number') {
        genderRatio = { ladies: g.ladies, mens: g.mens, others: g.others }
      }
      const a = parsed?.salonAgePercentages
      if (a && Array.isArray(a.ladies) && Array.isArray(a.mens) && Array.isArray(a.others)) {
        ageRatio = { ladies: a.ladies, mens: a.mens, others: a.others }
      }
    } catch {
      // 埋め込みJSONの形式が変わった場合はnullのまま(呼び出し側でベストエフォート扱い)
    }
  }

  // 2026-08-21追記(ユーザー提供の実HTMLで確認): 「〜の雰囲気」セクションは
  // h2見出しの直後のdiv内に、写真+キャプション(p.fgGray.fs10.mT10)の
  // リストが並ぶ構造。見出しの完全一致テキストがサロン名込みで変動するため、
  // 「の雰囲気」で終わる見出しをテキストで判定する(こだわり等の他ページと
  // 混同しないよう、末尾一致のみ)。
  const atmosphereCaptions: string[] = []
  $('h2').each((_, h2) => {
    const heading = $(h2).text().trim()
    if (!heading.endsWith('の雰囲気')) return
    const container = $(h2).closest('div.mT30')
    container.find('p.fgGray.fs10.mT10').each((__, p) => {
      const text = $(p).text().replace(/\s+/g, ' ').trim()
      if (text) atmosphereCaptions.push(text)
    })
    return false
  })

  // 「〜のサロンデータ」テーブル(table.slnDataTbl): 1行にth+td(colspan)が
  // 1組、または2組並ぶ形式が混在するため、行内のth/tdを出現順にペアリングする。
  const salonData: { label: string; value: string }[] = []
  $('table.slnDataTbl').first().find('tr').each((_, tr) => {
    const cells = $(tr).children()
    const ths = cells.filter('th').toArray()
    const tds = cells.filter('td').toArray()
    for (let i = 0; i < Math.min(ths.length, tds.length); i++) {
      const label = $(ths[i]).text().replace(/\s+/g, ' ').trim()
      const value = $(tds[i]).text().replace(/\s+/g, ' ').trim()
      if (label && value) salonData.push({ label, value })
    }
  })

  // 特集カルーセル(#jsiSpecialFeatureCarousel): ナビ用の重複ブロック
  // (.cpnTyingMainNavi)ではなく、本体(ul.cpnTyingMain > li)だけを対象にする。
  const specials: { category: string; headline: string; description: string }[] = []
  $('#jsiSpecialFeatureCarousel ul.cpnTyingMain > li').each((_, li) => {
    const $li = $(li)
    const category = $li.find('.cpnTyingTitle').first().text().replace(/\s+/g, ' ').trim()
    const $desc = $li.find('.cpnTyingDescription').first()
    const headline = $desc.find('p').first().text().replace(/\s+/g, ' ').trim()
    const description = $desc.find('p').eq(1).text().replace(/\s+/g, ' ').trim()
    if (category || headline) specials.push({ category, headline, description })
  })

  return {
    catchCopy, description, message, avgPriceFirstVisit, avgPriceRepeat, genderRatio, ageRatio,
    atmosphereCaptions, salonData, specials
  }
}

export type HpbKodawariStep = {
  title: string
  body: string
  imageUrl: string | null
}

export type HpbKodawariPage = {
  catchTitle: string | null
  catchText: string | null
  steps: HpbKodawariStep[]
}

/**
 * HPB公開「こだわり」ページ(https://beauty.hotpepper.jp/sln{ID}/kodawari/、
 * 2ページ目以降は/kodawari/2/等)を1ページ分パースする。ページ上部の
 * ul.kodawariTabに他のこだわりページへのリンクが全件載っているため、
 * あわせて絶対URLで返す(呼び出し側でこだわり1から辿って全ページ取得する)。
 */
export function parseHpbKodawariPage(html: string): { page: HpbKodawariPage; otherPageUrls: string[] } {
  const $ = cheerio.load(html)

  const catchTitle = $('h2.kodawariCatch').first().text().replace(/\s+/g, ' ').trim() || null
  const catchText = $('p.kodawariCatchTxt').first().text().replace(/\s+/g, ' ').trim() || null

  const steps: HpbKodawariStep[] = []
  $('li.kodawariStepCassette').each((_, li) => {
    const $li = $(li)
    const title = $li.find('.kodawariTtl').first().text().replace(/\s+/g, ' ').trim()
    const body = $li.find('.kodawariTxt').first().text().replace(/\s+/g, ' ').trim()
    const imageUrl = $li.find('img').first().attr('src') || null
    if (title || body) steps.push({ title, body, imageUrl })
  })

  const otherPageUrls: string[] = []
  $('ul.kodawariTab a.kodawariTabAnchor').each((_, a) => {
    const href = $(a).attr('href')
    if (href) otherPageUrls.push(href)
  })

  return { page: { catchTitle, catchText, steps }, otherPageUrls }
}

export type HpbStylistDetailInfo = {
  /** dt.fgPink.b.fs14(スタイリストの一言キャッチ) */
  catchTitle: string | null
  /** dd.mT10.wbba(キャッチに続く自己紹介文) */
  bio: string | null
  /** dl(dt.w10em.b + dd.oh.wbba)のラベル→値。例: 得意なイメージ/得意な技術/趣味・マイブーム */
  fields: Record<string, string>
}

/**
 * HPB公開スタイリスト個別ページ(https://beauty.hotpepper.jp/sln{ID}/stylist/{Tコード}/)
 * をパースする。呼び出し側はstylists.salonboard_stylist_key(Tコード)を
 * 既に持っている前提で、そのスタイリスト分だけ都度アクセスする。
 */
export function parseHpbStylistDetailPage(html: string): HpbStylistDetailInfo {
  const $ = cheerio.load(html)

  const catchTitle = $('dt.fgPink.b.fs14').first().text().replace(/\s+/g, ' ').trim() || null
  const bio = $('dd.mT10.wbba').first().text().replace(/\s+/g, ' ').trim() || null

  const fields: Record<string, string> = {}
  $('dl').each((_, dl) => {
    const $dt = $(dl).children('dt.w10em')
    const $dd = $(dl).children('dd.oh')
    if ($dt.length === 0 || $dd.length === 0) return
    const label = $dt.text().replace(/\s+/g, ' ').trim()
    const value = $dd.text().replace(/\s+/g, ' ').trim()
    if (label && value) fields[label] = value
  })

  return { catchTitle, bio, fields }
}

/**
 * genderRatio/ageRatioを、AI生成の参考材料として使える1行の日本語テキストに整形する。
 * どちらも取得できていない場合はnullを返す。
 */
export function formatCustomerRatioText(genderRatio: SalonGenderPercentages | null, ageRatio: SalonAgePercentages | null): string | null {
  const parts: string[] = []
  if (genderRatio) {
    parts.push(`性別比率は女性${genderRatio.ladies}%・男性${genderRatio.mens}%・未設定その他${genderRatio.others}%`)
  }
  if (ageRatio) {
    const formatByGender = (label: string, values: (number | null)[]) => {
      const segs = AGE_RATIO_BUCKET_LABELS.map((bucketLabel, i) => {
        const v = values[i]
        return v === null || v === undefined ? null : `${bucketLabel}${v}%`
      }).filter((s): s is string => s !== null)
      return segs.length > 0 ? `${label}=${segs.join('/')}` : null
    }
    const genderSegs = [
      formatByGender('女性', ageRatio.ladies),
      formatByGender('男性', ageRatio.mens),
      formatByGender('その他', ageRatio.others)
    ].filter((s): s is string => s !== null)
    if (genderSegs.length > 0) {
      parts.push(`年代内訳は${genderSegs.join('、')}`)
    }
  }
  return parts.length > 0 ? parts.join('。') : null
}

/** 「〜の雰囲気」セクションの写真キャプション群を、AI参考材料用の1テキストに整形する */
export function formatAtmosphereText(captions: string[]): string | null {
  return captions.length > 0 ? captions.join('／') : null
}

/** 「〜のサロンデータ」テーブルを、AI参考材料用の1テキストに整形する */
export function formatSalonDataText(salonData: { label: string; value: string }[]): string | null {
  return salonData.length > 0 ? salonData.map((row) => `${row.label}: ${row.value}`).join('\n') : null
}

/** サロントップの特集カルーセルを、AI参考材料用の1テキストに整形する */
export function formatSpecialsText(
  specials: { category: string; headline: string; description: string }[]
): string | null {
  if (specials.length === 0) return null
  return specials
    .map((s) => [s.category, s.headline, s.description].filter(Boolean).join(' / '))
    .join('\n')
}

/** こだわりページ群を、AI参考材料用の1テキストに整形する(全ステップ本文は長大なため見出しのみ) */
export function formatKodawariText(pages: HpbKodawariPage[]): string | null {
  if (pages.length === 0) return null
  return pages
    .map((page) => {
      const lines = [page.catchTitle, page.catchText].filter((l): l is string => !!l)
      if (page.steps.length > 0) {
        lines.push(`見どころ: ${page.steps.map((s) => s.title).filter(Boolean).join('／')}`)
      }
      return lines.join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

/** スタイリスト個別ページのプロフィールを、stylists.hpb_bio_text用の1テキストに整形する */
export function formatStylistBioText(info: HpbStylistDetailInfo): string | null {
  const lines: string[] = []
  if (info.catchTitle) lines.push(info.catchTitle)
  if (info.bio) lines.push(info.bio)
  for (const [label, value] of Object.entries(info.fields)) {
    if (label === 'スタイリスト歴') continue
    lines.push(`${label}: ${value}`)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

export type HpbCouponListItem = {
  /** coupons.salonboard_coupon_keyと同じ形式(例: CP00000007918355)。予約リンクのcouponIdクエリから抽出 */
  couponSalonboardKey: string | null
  name: string
  description: string
}

export type HpbCouponListPageResult = {
  items: HpbCouponListItem[]
  nextPageUrl: string | null
}

/**
 * HPB公開「クーポン・メニュー」ページ(https://beauty.hotpepper.jp/sln{ID}/coupon/、
 * 2ページ目以降は<link rel="next">を辿る)を1ページ分パースする。
 * table.couponTable単位がクーポン(table.menuTblはクーポン無しの単なるメニューの
 * ため対象外)。個々のクーポンIDはdata属性ではなく予約リンクのcouponId=クエリに
 * しか無い(2026-08-21追記(ユーザー提供の実HTMLで確認))。
 */
export function parseHpbCouponListPage(html: string): HpbCouponListPageResult {
  const $ = cheerio.load(html)

  const items: HpbCouponListItem[] = []
  $('table.couponTable').each((_, table) => {
    const $table = $(table)
    const name = $table.find('.couponMenuName').first().text().replace(/\s+/g, ' ').trim()
    const description = $table.find('.couponDescription').first().text().replace(/\s+/g, ' ').trim()

    let couponSalonboardKey: string | null = null
    $table.find('a[href*="couponId="]').each((_, a) => {
      const href = $(a).attr('href') || ''
      const match = href.match(/couponId=(CP\d+)/)
      if (!match) return
      couponSalonboardKey = match[1]
      return false
    })

    if (name || description) items.push({ couponSalonboardKey, name, description })
  })

  const nextPageUrl = $('link[rel="next"]').attr('href') || null

  return { items, nextPageUrl }
}

/** HPB公開クーポン一覧を、AI参考材料用の1テキストに整形する(件数が多いため上限を設ける) */
const MAX_COUPONS_IN_TEXT = 15
export function formatCouponsText(items: HpbCouponListItem[]): string | null {
  if (items.length === 0) return null
  return items
    .slice(0, MAX_COUPONS_IN_TEXT)
    .map((c) => [c.name, c.description].filter(Boolean).join(' / '))
    .join('\n')
}

export type HpbBlogListItem = {
  title: string | null
  excerpt: string
  sourceUrl: string
  /** "YYYY-MM-DD"。一覧ページに日付表示が無い/検出できない場合はnull */
  postedDate: string | null
  /** HPB_BLOG_CATEGORY_OPTIONS(blog.tsx)のいずれかのラベル文字列と一致する想定 */
  categoryName: string | null
  stylistName: string | null
  /** stylists.salonboard_stylist_keyと同じ形式のTコード(例: T001090850) */
  stylistSalonboardKey: string | null
}

export type HpbBlogListPageResult = {
  items: HpbBlogListItem[]
  nextPageUrl: string | null
}

/**
 * HPB公開ブログ一覧ページ(https://beauty.hotpepper.jp/{hpbSlnId}/blog/)
 * 1ページ分をパースする。一覧には抜粋(「続きを見る」で個別ページへの
 * リンク)のみが掲載されており、全文は個別ページに遷移しないと取得できない。
 * AI生成の参考材料としては抜粋で十分なため、個別ページへの追加アクセスは行わない。
 * 2026-08-21追記(ユーザー提供の実HTMLで確認): 一覧の各カセットには
 * カテゴリ(class="blogCategory"のdiv)と投稿者(href="…/stylist/{Tコード}/"の
 * リンク)も掲載されている。取り込み時にblog_articlesのcategory_id/
 * stylist_idへ反映するため、あわせて取得する。
 */
export function parseHpbBlogListPage(html: string): HpbBlogListPageResult {
  const $ = cheerio.load(html)

  const items: HpbBlogListItem[] = []
  $('li.blogListCassette').each((_, li) => {
    const $li = $(li)
    const title = $li.find('.blogListTtl').first().text().replace(/\s+/g, ' ').trim() || null

    const $excerptBlock = $li.find('.mT5.wwbw').first()
    if ($excerptBlock.length === 0) return
    const sourceUrl = $excerptBlock.find('a').first().attr('href') || ''
    if (!sourceUrl) return

    const $excerptClone = $excerptBlock.clone()
    $excerptClone.find('a').remove()
    $excerptClone.find('br').replaceWith('\n')
    const excerpt = $excerptClone.text().replace(/\n\s+/g, '\n').trim().replace(/…$/, '')
    if (!excerpt) return

    // 一覧上の日付表示は現状未確認のため、見つかれば拾う程度のベストエフォート
    const dateText = $li.text().match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    const postedDate = dateText ? `${dateText[1]}-${dateText[2].padStart(2, '0')}-${dateText[3].padStart(2, '0')}` : null

    const categoryName = $li.find('.blogCategory').first().text().replace(/\s+/g, ' ').trim() || null

    let stylistName: string | null = null
    let stylistSalonboardKey: string | null = null
    $li.find('a[href*="/stylist/"]').each((_, a) => {
      const href = $(a).attr('href') || ''
      const match = href.match(/\/stylist\/([^/]+)\/?/)
      if (!match) return
      stylistSalonboardKey = match[1]
      stylistName = $(a).text().replace(/\s+/g, ' ').trim() || null
      return false
    })

    items.push({ title, excerpt, sourceUrl, postedDate, categoryName, stylistName, stylistSalonboardKey })
  })

  const nextPageUrl = $('link[rel="next"]').attr('href') || null

  return { items, nextPageUrl }
}

export type HpbBlogDetailResult = {
  title: string | null
  /** 全文(埋め込み画像を除いた本文テキスト、<br />は改行に変換) */
  body: string | null
  /** 本文中に埋め込まれた画像のURL(一覧サムネと同じCDNパス、サイズのクエリ違い) */
  imageUrl: string | null
  categoryName: string | null
  stylistName: string | null
  stylistSalonboardKey: string | null
  /** coupons.salonboard_coupon_keyと同じ形式(例: CP00000010528227) */
  couponSalonboardKey: string | null
}

/**
 * HPB公開ブログ個別記事ページ(blog_reference_articles.source_urlが指すページ)を
 * パースする。一覧ページと違い、全文・本文埋め込み画像・おすすめクーポンが
 * 掲載されている。2026-08-21追記(ユーザー提供の実HTMLで確認した構造):
 *   - dl.blogDtlInner > dt がタイトル、> dd が本文(先頭に画像を含む)
 *   - div.blogCategoryLarge.dynamicBlogCategory がカテゴリ(一覧側とクラス名が異なる)
 *   - div.blogSidePosterWrap 内の a[href*="/stylist/"] が投稿者
 *   - table.couponTable 内の data-couponid 属性(CP########形式)がおすすめクーポン
 */
export function parseHpbBlogDetailPage(html: string): HpbBlogDetailResult {
  const $ = cheerio.load(html)

  const title = $('dl.blogDtlInner dt').first().text().replace(/\s+/g, ' ').trim() || null

  const $dd = $('dl.blogDtlInner dd').first()
  let imageUrl: string | null = null
  let body: string | null = null
  if ($dd.length > 0) {
    const src = $dd.find('img').first().attr('src') || null
    imageUrl = src ? (src.startsWith('http') ? src : `https:${src.replace(/^\/\//, '')}`) : null

    const $bodyClone = $dd.clone()
    $bodyClone.find('img').remove()
    $bodyClone.find('div.taC').remove()
    $bodyClone.find('br').replaceWith('\n')
    body = $bodyClone.text().replace(/\n{3,}/g, '\n\n').trim() || null
  }

  const categoryName = $('.blogCategoryLarge').first().text().replace(/\s+/g, ' ').trim() || null

  let stylistName: string | null = null
  let stylistSalonboardKey: string | null = null
  const $stylistLinks =
    $('div.blogSidePosterWrap a[href*="/stylist/"]').length > 0
      ? $('div.blogSidePosterWrap a[href*="/stylist/"]')
      : $('a[href*="/stylist/"]')
  $stylistLinks.each((_, a) => {
    const href = $(a).attr('href') || ''
    const match = href.match(/\/stylist\/([^/]+)\/?/)
    if (!match) return
    stylistSalonboardKey = match[1]
    stylistName = $(a).text().replace(/\s+/g, ' ').trim() || stylistName
    return false
  })

  const couponSalonboardKey = $('table.couponTable [data-couponid]').first().attr('data-couponid')?.trim() || null

  return { title, body, imageUrl, categoryName, stylistName, stylistSalonboardKey, couponSalonboardKey }
}
