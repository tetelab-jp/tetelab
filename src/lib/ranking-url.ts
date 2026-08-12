// ============================================
// ranking-url.ts
// ホットペッパービューティー(HPB)の公開検索ページの
// 「検索結果URL」を組み立てる純粋関数。
//
// ローカル運用していたPythonスクリプトは検索フォーム(#freeWordSearch)へ
// キーワードを打ち込んでブラウザ遷移させていたが、遷移後の結果ページは
//   https://beauty.hotpepper.jp/CSP/bt/salonSearch/search/
//     ?serviceAreaCd=SB      ← 大エリア(svcSB の "SB")
//     &middleAreaCd=BC       ← 中エリア(macBC の "BC")
//     &smallAreaCd=...       ← 小エリア(任意)
//     &freeword=...          ← キーワード(URLエンコード)
//     &searchGender=ALL
//     &sortType=popular      ← 人気順(この並びでの掲載順位を測る)
//     &fromSearchCondition=true
//     &pn=2                  ← ページ番号(20件/ページ)
// という規則的なGET URLになっている。よってブラウザ自動化は不要で、
// このURLを直接組み立ててfetchするだけで計測できる。
// ============================================

export const HPB_SEARCH_ENDPOINT = 'https://beauty.hotpepper.jp/CSP/bt/salonSearch/search/'

/** エリア選択(パスの svc/mac/smc 接尾辞がそのまま各Cdの値になる) */
export type AreaSelection = {
  serviceAreaCd: string // 大エリア 例: 'SA'(関東) 'SB'(関西) 'SC'(東海)
  middleAreaCd?: string // 中エリア 例: 'BC'
  smallAreaCd?: string // 小エリア(任意)
}

export type SearchUrlOptions = {
  page?: number // 1始まり
  searchGender?: string // 既定 'ALL'
  sortType?: string // 既定 'popular'(人気順)
}

/**
 * 大/中/小エリア + キーワード + ページ番号 から検索結果URLを組み立てる。
 * freewordのURLエンコードはURLSearchParamsが行う(白髪ぼかし→%E7%99%BD...)。
 */
export function buildSearchUrl(
  area: AreaSelection,
  freeword: string,
  options: SearchUrlOptions = {}
): string {
  const page = options.page && options.page > 0 ? options.page : 1
  const params = new URLSearchParams()
  params.set('serviceAreaCd', area.serviceAreaCd)
  if (area.middleAreaCd) params.set('middleAreaCd', area.middleAreaCd)
  if (area.smallAreaCd) params.set('smallAreaCd', area.smallAreaCd)
  params.set('freeword', freeword)
  params.set('searchGender', options.searchGender ?? 'ALL')
  params.set('sortType', options.sortType ?? 'popular')
  params.set('fromSearchCondition', 'true')
  params.set('pn', String(page))
  return `${HPB_SEARCH_ENDPOINT}?${params.toString()}`
}

/**
 * エリアのパス表記("svcSA" / "macBC" / "smcXXX")から各Cd値(接尾辞)を取り出す。
 * エリアマスターのクロールで得たパスを AreaSelection へ変換する用途。
 */
export function areaCodeFromPath(pathToken: string): string {
  return pathToken.replace(/^(svc|mac|smc)/i, '')
}
