// 2026-08-22追記(ユーザー指定): クライアント側でページングする一覧(HPBからの
// スタイル/ブログ取り込み一覧、テンプレート反映対象の絞り込み一覧)で共通利用する
// ページ送りUI。単純な「← 前へ」「次へ →」のテキストリンクは押せることが
// わかりにくかったため、枠付きの明確なボタンに変更し、5ページ単位のジャンプ・
// 最初/最後へのジャンプも追加した。実際の表示切り替え・件数計算は各ページの
// JS側(idPrefix経由でDOM要素を取得)で行う。
export function PaginationBar({ idPrefix }: { idPrefix: string }) {
  const btnClass =
    'w-9 h-9 flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-pink-50 hover:text-pink-600 hover:border-pink-300 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500 disabled:hover:border-gray-200 transition-colors flex-shrink-0'
  return (
    <div id={`${idPrefix}-pagination`} class="hidden items-center justify-between gap-1 text-sm text-gray-500 mt-3 pt-3 border-t border-gray-100">
      <div class="flex items-center gap-1">
        <button type="button" id={`${idPrefix}-page-first`} class={btnClass} title="最初へ" disabled>
          <i class="fas fa-angles-left"></i>
        </button>
        <button type="button" id={`${idPrefix}-page-back5`} class={btnClass} title="5ページ戻る" disabled>
          <i class="fas fa-angle-left"></i>
        </button>
        <button type="button" id={`${idPrefix}-page-prev`} class={btnClass} title="前へ" disabled>
          <i class="fas fa-chevron-left"></i>
        </button>
      </div>
      <span id={`${idPrefix}-pagination-label`} class="text-xs sm:text-sm font-semibold text-gray-500 text-center whitespace-nowrap"></span>
      <div class="flex items-center gap-1">
        <button type="button" id={`${idPrefix}-page-next`} class={btnClass} title="次へ" disabled>
          <i class="fas fa-chevron-right"></i>
        </button>
        <button type="button" id={`${idPrefix}-page-fwd5`} class={btnClass} title="5ページ進む" disabled>
          <i class="fas fa-angle-right"></i>
        </button>
        <button type="button" id={`${idPrefix}-page-last`} class={btnClass} title="最後へ" disabled>
          <i class="fas fa-angles-right"></i>
        </button>
      </div>
    </div>
  )
}
