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
  type SalonAreaInfo
} from './ranking-parse'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PER_PAGE = 20
const DEFAULT_MAX_PAGES = 50 // Python版と同じ上限
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
