// ============================================
// ranking-scraper.ts
// HPBの公開検索ページを fetch して、対象サロンの掲載順位を計測する。
// ブラウザ自動化(Puppeteer)は使わず、ranking-url.ts が組み立てるURLを
// 直接 fetch → ranking-parse.ts でパース → ページ送り、という軽量構成。
//
// 注意: HPBはデータセンターIPからのアクセスを制限することがあるため、
// 本番で直fetchが弾かれる場合に備え、任意のHTTP(S)プロキシを挿せるように
// している(proxyUrl)。指定が無ければ直アクセスする。
// ============================================

import { buildSearchUrl, type AreaSelection } from './ranking-url'
import {
  parseSearchResultPage,
  findSalonRankInPage,
  extractSalonAreaFromSlnPage,
  parseHpbReviewPage,
  extractSalonProfileFromSlnPage,
  parseHpbBlogListPage,
  type SalonAreaInfo,
  type HpbReviewItem,
  type SalonHpbProfileInfo,
  type HpbBlogListItem
} from './ranking-parse'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PER_PAGE = 20
const DEFAULT_MAX_PAGES = 5 // 100位(1ページ20件×5)より下は打ち切り。呼び出し側(ranking.tsx)は明示的にmaxPagesを渡す
const DEFAULT_DELAY_MS = 1500 // ページ送りの間隔(サイトに優しく・弾かれ軽減)
const FETCH_RETRY = 3

export type ScrapeOptions = {
  maxPages?: number
  delayMs?: number
  /** 例: 'http://user:pass@host:port'。未指定なら直アクセス */
  proxyUrl?: string
  signal?: AbortSignal
}

export type MeasureResult = {
  rank: number | null // null = 圏外
  resultCount: number | null // 該当数
  pagesScanned: number
  matchedSlnId: string | null
  status: 'ok' | 'not_found' | 'error'
  errorMessage?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * proxyUrl が指定されていれば undici の ProxyAgent を dispatcher として返す。
 * undici が読めない/生成に失敗した場合は undefined(直アクセス)にフォールバック。
 */
async function makeDispatcher(proxyUrl?: string): Promise<unknown | undefined> {
  if (!proxyUrl) return undefined
  try {
    const undici = (await import('undici')) as { ProxyAgent: new (url: string) => unknown }
    return new undici.ProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

async function fetchHtml(
  url: string,
  dispatcher: unknown | undefined,
  signal?: AbortSignal
): Promise<string> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= FETCH_RETRY; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'ja,en-US;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal,
        // dispatcher は undici(Nodeのfetch実装)独自オプション。型に無いのでキャスト。
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {})
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      lastErr = e
      if (attempt < FETCH_RETRY) await sleep(2000 * attempt) // 2s,4s のバックオフ
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * 対象サロンの順位を計測する。
 * ページ1から順に取得し、見つかったらその順位を返す。最大 maxPages まで走査。
 */
export async function measureRank(
  area: AreaSelection,
  salonName: string,
  keyword: string,
  options: ScrapeOptions = {}
): Promise<MeasureResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  let resultCount: number | null = null
  let page = 0
  try {
    const dispatcher = await makeDispatcher(options.proxyUrl)
    for (page = 1; page <= maxPages; page++) {
      const url = buildSearchUrl(area, keyword, { page })
      const html = await fetchHtml(url, dispatcher, options.signal)
      const parsed = parseSearchResultPage(html)
      if (page === 1) resultCount = parsed.resultCount

      const match = findSalonRankInPage(html, salonName, page, PER_PAGE)
      if (match) {
        return {
          rank: match.rank,
          resultCount,
          pagesScanned: page,
          matchedSlnId: match.slnId,
          status: 'ok'
        }
      }
      // 次ページが無い or 掲載0件なら打ち切り
      if (!parsed.hasNextPage || parsed.cassettes.length === 0) break
      await sleep(delayMs)
    }
    return {
      rank: null,
      resultCount,
      pagesScanned: page > maxPages ? maxPages : page,
      matchedSlnId: null,
      status: 'not_found'
    }
  } catch (e) {
    return {
      rank: null,
      resultCount,
      pagesScanned: Math.max(0, page - 1),
      matchedSlnId: null,
      status: 'error',
      errorMessage: e instanceof Error ? e.message : String(e)
    }
  }
}

// --------------------------------------------
// サロン自身のHPBページからの対策エリア自動検出
// --------------------------------------------

/** サロンの公開ページ(https://beauty.hotpepper.jp/sln{STORE_ID}/)から中/小エリアを取得 */
export async function fetchSalonAreaFromHpb(
  hpbSlnId: string,
  options: ScrapeOptions = {}
): Promise<SalonAreaInfo> {
  const dispatcher = await makeDispatcher(options.proxyUrl)
  const html = await fetchHtml(`https://beauty.hotpepper.jp/${hpbSlnId}/`, dispatcher, options.signal)
  return extractSalonAreaFromSlnPage(html)
}

// --------------------------------------------
// 口コミ管理ツール(2026-08-16追記): HPB公開口コミ一覧の取得
// --------------------------------------------

export type HpbReviewListResult = {
  items: HpbReviewItem[]
  pagesScanned: number
  /** 1ページ目の「サロン平均」バッジの値(参考表示用) */
  salonAverageScore: number | null
}

const DEFAULT_MAX_HPB_REVIEW_PAGES = 200
const DEFAULT_HPB_REVIEW_PAGE_DELAY_MS = 800

/**
 * HPB公開口コミ一覧(https://beauty.hotpepper.jp/{hpbSlnId}/review/、
 * 2ページ目以降は<link rel="next">が示すURLを辿る)を全ページ巡回して
 * 取得する。ログイン不要・Puppeteer不要(ranking-scraper.tsの既存fetch
 * 機構を再利用)。
 */
export async function fetchHpbReviewList(
  hpbSlnId: string,
  options: ScrapeOptions = {}
): Promise<HpbReviewListResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_HPB_REVIEW_PAGES
  const delayMs = options.delayMs ?? DEFAULT_HPB_REVIEW_PAGE_DELAY_MS
  const dispatcher = await makeDispatcher(options.proxyUrl)

  const items: HpbReviewItem[] = []
  let url: string | null = `https://beauty.hotpepper.jp/${hpbSlnId}/review/`
  let salonAverageScore: number | null = null
  let pagesScanned = 0

  while (url && pagesScanned < maxPages) {
    const html = await fetchHtml(url, dispatcher, options.signal)
    const parsed = parseHpbReviewPage(html)
    pagesScanned += 1
    if (pagesScanned === 1) salonAverageScore = parsed.salonAverageScore
    items.push(...parsed.items)
    if (!parsed.nextPageUrl) break
    url = parsed.nextPageUrl
    await sleep(delayMs)
  }

  return { items, pagesScanned, salonAverageScore }
}

// --------------------------------------------
// ブログ参考材料機能(2026-08-17追記): HPB公開サロンページ・公開ブログ一覧の取得
// --------------------------------------------

/** サロンの公開ページからキャッチコピー・紹介文・「からの一言」メッセージを取得する */
export async function fetchSalonProfileFromHpb(
  hpbSlnId: string,
  options: ScrapeOptions = {}
): Promise<SalonHpbProfileInfo> {
  const dispatcher = await makeDispatcher(options.proxyUrl)
  const html = await fetchHtml(`https://beauty.hotpepper.jp/${hpbSlnId}/`, dispatcher, options.signal)
  return extractSalonProfileFromSlnPage(html)
}

export type HpbBlogArticlesResult = {
  items: HpbBlogListItem[]
  pagesScanned: number
}

const DEFAULT_MAX_BLOG_ARTICLES = 100
const DEFAULT_HPB_BLOG_PAGE_DELAY_MS = 800

/**
 * HPB公開ブログ一覧(https://beauty.hotpepper.jp/{hpbSlnId}/blog/)を、
 * 最大件数(デフォルト100件)に達するかページが尽きるまで巡回して取得する。
 * ログイン不要・Puppeteer不要。一覧の抜粋のみを取得し、個別記事ページへの
 * 追加アクセスは行わない(AI生成の参考材料としては抜粋で十分なため)。
 */
export async function fetchHpbBlogArticles(
  hpbSlnId: string,
  options: ScrapeOptions & { maxArticles?: number } = {}
): Promise<HpbBlogArticlesResult> {
  const maxArticles = options.maxArticles ?? DEFAULT_MAX_BLOG_ARTICLES
  const maxPages = options.maxPages ?? DEFAULT_MAX_HPB_REVIEW_PAGES
  const delayMs = options.delayMs ?? DEFAULT_HPB_BLOG_PAGE_DELAY_MS
  const dispatcher = await makeDispatcher(options.proxyUrl)

  const items: HpbBlogListItem[] = []
  let url: string | null = `https://beauty.hotpepper.jp/${hpbSlnId}/blog/`
  let pagesScanned = 0

  while (url && pagesScanned < maxPages && items.length < maxArticles) {
    const html = await fetchHtml(url, dispatcher, options.signal)
    const parsed = parseHpbBlogListPage(html)
    pagesScanned += 1
    items.push(...parsed.items)
    if (!parsed.nextPageUrl) break
    url = parsed.nextPageUrl
    await sleep(delayMs)
  }

  return { items: items.slice(0, maxArticles), pagesScanned }
}

/**
 * HPB公開ブログ個別記事ページ(blog_reference_articles.source_url)のHTMLを
 * そのまま取得する(パースはranking-parse.tsのparseHpbBlogDetailPageで行う)。
 * 一覧の巡回とは異なり、呼び出し側が「選択された数件だけ」都度呼び出す想定。
 */
export async function fetchHpbBlogDetailHtml(sourceUrl: string, options: ScrapeOptions = {}): Promise<string> {
  const dispatcher = await makeDispatcher(options.proxyUrl)
  return fetchHtml(sourceUrl, dispatcher, options.signal)
}

/**
 * HPB公開ブログの本文埋め込み画像(imageUrl)をダウンロードし、バイト列で返す。
 * サムネと同じCDNパスで、クエリのw/hだけがサイズ違い(一覧=119、個別=349)。
 * より大きいサイズを狙ってw/hを引き上げて取得を試み、失敗した場合は元のURLに
 * フォールバックする(それでも失敗すれば呼び出し側で画像なしとして扱う)。
 */
export async function fetchHpbBlogImageBuffer(
  imageUrl: string,
  options: ScrapeOptions = {}
): Promise<ArrayBuffer> {
  const dispatcher = await makeDispatcher(options.proxyUrl)
  const fetchOnce = async (url: string): Promise<ArrayBuffer> => {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      signal: options.signal,
      ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {})
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.arrayBuffer()
  }

  const largerUrl = imageUrl.replace(/([?&])w=\d+&h=\d+/, '$1w=750&h=750')
  if (largerUrl !== imageUrl) {
    try {
      return await fetchOnce(largerUrl)
    } catch {
      // フォールバックして元URLで再試行
    }
  }
  return fetchOnce(imageUrl)
}
