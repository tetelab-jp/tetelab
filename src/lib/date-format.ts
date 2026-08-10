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
