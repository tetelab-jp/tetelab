// ============================================
// review-match.ts
// サロンボード口コミ一覧(担当スタイリスト・投稿日時・本文冒頭)と
// HPB公開口コミ一覧(評点・本文全文・属性)を、投稿日+本文冒頭の一致で
// 突合する。詳細/返信ページ(reviewReply/)は一切使わない設計。
//
// 実データ(2026-08-16、実際のサロンボード/HPB画面)で4件連続一致を確認
// 済み。同日に複数件投稿されるケースは本文一致で1対1に振り分ける。
// 本文一致を優先し、日付は補助情報として扱う(サロンボードの口コミ審査に
// 2〜10営業日かかるため、投稿日がわずかにズレる可能性を考慮)。
// ============================================

import type { HpbReviewItem } from './ranking-parse'

export type SalonBoardReviewRow = {
  managementNo: string
  postedAt: string // worker(salonboard-automation.ts)がそのまま返す "2026/08/15 14:07" 形式
  visitedAt: string
  reservationName: string
  stylistNameRaw: string
  bodyExcerpt: string
  replyStatus: string
}

export type ReviewMatchResult = {
  managementNo: string
  postedAt: string
  visitedAt: string
  reservationName: string
  stylistNameRaw: string
  replyStatus: string
  matched: boolean
  hpb: HpbReviewItem | null
}

const TRAILING_ELLIPSIS_RE = /(…|\.\.\.)+$/

/** NFKC正規化 + 空白(改行含む)を完全除去。表記の改行/余白の違いを吸収して前方一致判定するため */
function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '')
}

function stripTrailingEllipsis(s: string): string {
  return s.replace(TRAILING_ELLIPSIS_RE, '')
}

/** "2026/08/15 14:07" 等から日付部分だけを "YYYY-MM-DD" に正規化する */
function parseSbPostedDate(raw: string): string | null {
  const m = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  if (!m) return null
  const [, y, mo, d] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/** "2026/08/15 14:07" → "2026-08-15 14:07:00"(PostgreSQLのTIMESTAMPリテラルに渡せる形式) */
export function parseSbPostedAtTimestamp(raw: string): string | null {
  const date = parseSbPostedDate(raw)
  if (!date) return null
  const m = raw.match(/(\d{1,2}):(\d{2})/)
  const time = m ? `${m[1].padStart(2, '0')}:${m[2]}:00` : '00:00:00'
  return `${date} ${time}`
}

/** "2026/07/28" → "2026-07-28"(DATE列用) */
export function parseSbDateOnly(raw: string): string | null {
  return parseSbPostedDate(raw)
}

/**
 * サロンボード側の各行に、HPB側の口コミ(評点・全文)を1対1で対応付ける。
 * 対応が見つからない行(HPB側にまだ掲載されていない=審査中の可能性)は
 * matched=false・hpb=nullで返す(呼び出し側でmatched_at=NULLのまま保持する)。
 */
export function matchReviews(sbRows: SalonBoardReviewRow[], hpbItems: HpbReviewItem[]): ReviewMatchResult[] {
  const usedHpbIndexes = new Set<number>()

  const byDate = new Map<string, number[]>()
  hpbItems.forEach((item, idx) => {
    const list = byDate.get(item.postedDate) ?? []
    list.push(idx)
    byDate.set(item.postedDate, list)
  })

  const results: ReviewMatchResult[] = []
  for (const row of sbRows) {
    const snippet = stripTrailingEllipsis(normalizeForMatch(row.bodyExcerpt))
    const postedDate = parseSbPostedDate(row.postedAt)

    let matchedIdx: number | null = null
    if (snippet) {
      // 1. 同日バケツ内での本文前方一致を優先する(通常はこれで確定する)
      const sameDayIdxs = postedDate ? byDate.get(postedDate) ?? [] : []
      const sameDayMatch = sameDayIdxs.find(
        (idx) => !usedHpbIndexes.has(idx) && normalizeForMatch(hpbItems[idx].content).startsWith(snippet)
      )
      matchedIdx = sameDayMatch ?? null

      // 2. 同日で見つからなければ、審査ラグによる投稿日ズレを想定して全件から探す
      if (matchedIdx === null) {
        const idx = hpbItems.findIndex(
          (item, i) => !usedHpbIndexes.has(i) && normalizeForMatch(item.content).startsWith(snippet)
        )
        matchedIdx = idx === -1 ? null : idx
      }
    }

    if (matchedIdx !== null) usedHpbIndexes.add(matchedIdx)

    results.push({
      managementNo: row.managementNo,
      postedAt: row.postedAt,
      visitedAt: row.visitedAt,
      reservationName: row.reservationName,
      stylistNameRaw: row.stylistNameRaw,
      replyStatus: row.replyStatus,
      matched: matchedIdx !== null,
      hpb: matchedIdx !== null ? hpbItems[matchedIdx] : null
    })
  }
  return results
}
