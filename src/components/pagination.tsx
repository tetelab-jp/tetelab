// 2026-08-22追記(ユーザー指定): クライアント側でページングする一覧(HPBからの
// スタイル/ブログ取り込み一覧、テンプレート反映対象の絞り込み一覧)で共通利用する
// ページ送りUI。単純な「← 前へ」「次へ →」のテキストリンクは押せることが
// わかりにくかったため、枠付きの明確なボタンに変更し、5ページ単位のジャンプ・
// 最初/最後へのジャンプも追加した。
// 2026-08-22追記(ユーザー指定・修正): モバイルでは6個のボタンが並びきらず
// レイアウトが崩れていたため、最初へ/5ページ戻る/5ページ進む/最後への4ボタンは
// sm以上でのみ表示し、代わりにページ番号を直接入力してジャンプできる欄を
// 常時表示するようにした(前へ/次への2ボタンは常に表示)。
export function PaginationBar({ idPrefix }: { idPrefix: string }) {
  const btnBase =
    'w-8 h-8 sm:w-9 sm:h-9 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-pink-50 hover:text-pink-600 hover:border-pink-300 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-500 disabled:hover:border-gray-200 transition-colors flex-shrink-0'
  const btnAlways = 'flex ' + btnBase
  const btnSmOnly = 'hidden sm:flex ' + btnBase
  return (
    <div id={`${idPrefix}-pagination`} class="hidden flex-col gap-2 text-sm text-gray-500 mt-3 pt-3 border-t border-gray-100">
      <div class="flex items-center justify-between gap-1">
        <div class="flex items-center gap-1">
          <button type="button" id={`${idPrefix}-page-first`} class={btnSmOnly} title="最初へ" disabled>
            <i class="fas fa-angles-left"></i>
          </button>
          <button type="button" id={`${idPrefix}-page-back5`} class={btnSmOnly} title="5ページ戻る" disabled>
            <i class="fas fa-angle-left"></i>
          </button>
          <button type="button" id={`${idPrefix}-page-prev`} class={btnAlways} title="前へ" disabled>
            <i class="fas fa-chevron-left"></i>
          </button>
        </div>
        <span id={`${idPrefix}-pagination-label`} class="text-xs sm:text-sm font-semibold text-gray-500 text-center whitespace-nowrap px-1"></span>
        <div class="flex items-center gap-1">
          <button type="button" id={`${idPrefix}-page-next`} class={btnAlways} title="次へ" disabled>
            <i class="fas fa-chevron-right"></i>
          </button>
          <button type="button" id={`${idPrefix}-page-fwd5`} class={btnSmOnly} title="5ページ進む" disabled>
            <i class="fas fa-angle-right"></i>
          </button>
          <button type="button" id={`${idPrefix}-page-last`} class={btnSmOnly} title="最後へ" disabled>
            <i class="fas fa-angles-right"></i>
          </button>
        </div>
      </div>
      <div class="flex items-center justify-center gap-2">
        <span class="text-xs text-gray-400 whitespace-nowrap">ページ番号を指定して移動</span>
        <input
          type="number"
          min="1"
          inputmode="numeric"
          id={`${idPrefix}-page-jump-input`}
          class="w-16 text-center border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          id={`${idPrefix}-page-jump-btn`}
          class="text-xs font-semibold px-3 py-1.5 rounded-lg bg-pink-50 hover:bg-pink-100 border border-pink-300 text-pink-600 whitespace-nowrap"
        >
          移動する
        </button>
      </div>
    </div>
  )
}
