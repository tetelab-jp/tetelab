// ============================================
// review-stylist-match.ts
// 口コミ一覧(サロンボード側)の「担当スタイリスト」列は自由入力に近い
// プレーンテキストのため、stylists.name とのマッチングは表記ゆれを
// 吸収した完全一致のみで行う(誤マッチは実在スタイリストの評価を
// 汚染するため、あいまい一致はしない。plan参照)。
// ============================================

/** NFKC正規化 + 前後trim + 内部の連続空白を1つに圧縮 + 小文字化 */
export function normalizeStylistName(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/**
 * stylistNameRaw(口コミ一覧に載っている担当スタイリスト名)と、
 * サロン内のスタイリスト一覧を正規化完全一致で照合する。
 * 一致しなければnull(未マッチ、stylist_id=NULLのまま保持)。
 */
export function matchStylistName<T extends { id: number; name: string }>(
  stylistNameRaw: string | null | undefined,
  stylists: T[]
): T | null {
  const normalized = normalizeStylistName(stylistNameRaw)
  if (!normalized) return null
  return stylists.find((s) => normalizeStylistName(s.name) === normalized) ?? null
}
