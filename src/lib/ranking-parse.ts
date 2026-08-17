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

export type SalonHpbProfileInfo = {
  /** .shopCatchCopy */
  catchCopy: string | null
  /** .slnTopImgDescription */
  description: string | null
  /** 見出しに「からの一言」を含むセクションの本文(構造で辿るため、クラス名は
   *  サイト側の変更に多少強い。同じクラスが他の見出しにも使われているため
   *  テキスト内容で判定する) */
  message: string | null
}

/**
 * サロンの公開ページ(https://beauty.hotpepper.jp/sln{STORE_ID}/)から
 * キャッチコピー・紹介文・「からの一言」メッセージを抽出する。
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

  return { catchCopy, description, message }
}

export type HpbBlogListItem = {
  title: string | null
  excerpt: string
  sourceUrl: string
  /** "YYYY-MM-DD"。一覧ページに日付表示が無い/検出できない場合はnull */
  postedDate: string | null
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

    items.push({ title, excerpt, sourceUrl, postedDate })
  })

  const nextPageUrl = $('link[rel="next"]').attr('href') || null

  return { items, nextPageUrl }
}
