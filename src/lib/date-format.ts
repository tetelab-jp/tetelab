/**
 * D1(SQLite)のCURRENT_TIMESTAMPは "YYYY-MM-DD HH:MM:SS" 形式のUTC時刻
 * (タイムゾーン情報なし)で保存される。画面表示時は明示的にJST(UTC+9)へ
 * 変換してから表示する。
 */
export function formatJstDateTime(sqliteTimestamp: string | null | undefined): string {
  if (!sqliteTimestamp) return ''

  const isoLike = sqliteTimestamp.includes('T') ? sqliteTimestamp : sqliteTimestamp.replace(' ', 'T')
  const utcDate = new Date(isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`)
  if (isNaN(utcDate.getTime())) return sqliteTimestamp

  const jst = new Date(utcDate.getTime() + 9 * 60 * 60 * 1000)
  const yyyy = jst.getUTCFullYear()
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const mi = String(jst.getUTCMinutes()).padStart(2, '0')
  const ss = String(jst.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`
}

/** formatJstDateTimeの秒なし版(年/月/日 時:分まで)。 */
export function formatJstDate(sqliteTimestamp: string | null | undefined): string {
  const full = formatJstDateTime(sqliteTimestamp)
  return full.replace(/:\d{2}$/, '')
}

/** 時刻を含まない日付のみ(年-月-日)。 */
export function formatJstDateOnly(sqliteTimestamp: string | null | undefined): string {
  const full = formatJstDateTime(sqliteTimestamp)
  return full.slice(0, 10)
}

/**
 * 表示用の簡易日付(ハイフン無し・年は下2桁・月日は先頭ゼロ無し)。
 * 例: "2026-08-18" → "26/8/18"(2026-08-18追記・ユーザー指定: ハイフン区切りは
 * 使わずこの形式に統一する)。
 */
export function compactDate(yyyyMmDd: string | null | undefined): string {
  if (!yyyyMmDd || yyyyMmDd.length < 10) return yyyyMmDd || ''
  const [yyyy, mm, dd] = yyyyMmDd.slice(0, 10).split('-')
  return `${yyyy.slice(-2)}/${Number(mm)}/${Number(dd)}`
}

/** formatJstDateOnly() + compactDate()。TIMESTAMPカラムを"26/8/18"形式で表示する。 */
export function formatJstDateCompact(sqliteTimestamp: string | null | undefined): string {
  return compactDate(formatJstDateOnly(sqliteTimestamp))
}
