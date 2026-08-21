// 共通レイアウト（サイドバー・トップバー）
// 各ルート（dashboard/style/blog）から共有して利用する

export type NavKey =
  | 'dashboard'
  | 'settings'
  | 'settings-account'
  | 'style-library'
  | 'style-import'
  | 'style-template'
  | 'style-test-run'
  | 'blog-salon'
  | 'blog-template'
  | 'blog-articles'
  | 'blog-generate'
  | 'ranking-measure'
  | 'ranking-keywords'
  | 'review-trend'
  | 'review-by-stylist'
  | 'review-list'
  | 'auto-update'

const NAV_ITEMS: {
  key: NavKey
  href: string
  icon: string
  label: string
  group: 'main' | 'style' | 'blog' | 'settings' | 'ranking' | 'review'
}[] = [
  { key: 'dashboard', href: '/dashboard', icon: 'fa-gauge-high', label: 'ダッシュボード', group: 'main' },
  { key: 'style-library', href: '/style/library', icon: 'fa-images', label: '登録スタイル', group: 'style' },
  { key: 'style-import', href: '/style/import', icon: 'fa-cloud-arrow-down', label: 'HPBからスタイルを取り込む', group: 'style' },
  { key: 'style-template', href: '/style/template', icon: 'fa-sliders', label: 'テンプレート作成・適用', group: 'style' },
  { key: 'blog-articles', href: '/blog/articles', icon: 'fa-newspaper', label: '登録ブログ', group: 'blog' },
  { key: 'blog-generate', href: '/blog/generate', icon: 'fa-robot', label: 'AI記事生成', group: 'blog' },
  { key: 'blog-template', href: '/blog/template', icon: 'fa-wand-magic-sparkles', label: '生成テンプレート', group: 'blog' },
  { key: 'blog-salon', href: '/blog/salon', icon: 'fa-shop', label: 'HPBからブログを取り込む', group: 'blog' },
  { key: 'ranking-keywords', href: '/seo/keywords', icon: 'fa-list-check', label: '対策キーワード設定', group: 'ranking' },
  { key: 'ranking-measure', href: '/seo', icon: 'fa-magnifying-glass-chart', label: 'エリア順位測定', group: 'ranking' },
  { key: 'review-list', href: '/reviews/list', icon: 'fa-comments', label: '口コミ返信', group: 'review' },
  { key: 'review-trend', href: '/reviews/trend', icon: 'fa-chart-line', label: '口コミ評価', group: 'review' },
  { key: 'review-by-stylist', href: '/reviews/by-stylist', icon: 'fa-star', label: 'スタイリスト別評価', group: 'review' },
  { key: 'style-test-run', href: '/style/test-run', icon: 'fa-clock-rotate-left', label: '実行履歴', group: 'settings' },
  { key: 'auto-update', href: '/settings/auto-update', icon: 'fa-clock', label: '自動更新設定', group: 'settings' },
  { key: 'settings', href: '/settings/salonboard', icon: 'fa-key', label: 'サロンボード連携設定', group: 'settings' },
  { key: 'settings-account', href: '/settings/account', icon: 'fa-user-gear', label: 'アカウント設定', group: 'settings' }
]

const NAV_GROUPS: { title: string; key: 'main' | 'style' | 'blog' | 'settings' | 'ranking' | 'review' }[] = [
  { title: '', key: 'main' },
  { title: 'スタイル投稿', key: 'style' },
  { title: 'ブログ投稿', key: 'blog' },
  { title: '口コミ管理', key: 'review' },
  { title: 'SEO', key: 'ranking' },
  { title: '設定・確認', key: 'settings' }
]

// 管理者サイト(/admin/tool)でスタイル/ブログ/SEO/口コミ機能をOFFにされた
// サロンでは、該当機能のナビ項目自体を非表示にする(リンク先はrequireStyleEnabled/
// requireBlogEnabled/requireSeoEnabled/requireReviewEnabledでどのみちブロック
// されるが、押せるリンクを残さないため)。
function isNavItemVisible(
  item: { key: NavKey; group: string },
  styleEnabled: boolean,
  blogEnabled: boolean,
  seoEnabled: boolean,
  reviewEnabled: boolean,
  isImpersonated: boolean
) {
  // 2026-08-21追記(ユーザー指定): 実行履歴ページ自体は通常のサロンログインでも
  // 表示する(以前の「なりすましログイン限定」への変更は指示の意図と異なって
  // いたため戻す)。サロン間で見えてはいけない詳細(投稿ログ列)は
  // ページ内側(automation.tsx)でisImpersonated判定して隠す。
  if (item.group === 'style') return styleEnabled
  if (item.group === 'blog') return blogEnabled
  if (item.group === 'ranking') return seoEnabled
  if (item.group === 'review') return reviewEnabled
  return true
}

export function Sidebar({
  active,
  salonName,
  styleEnabled = true,
  blogEnabled = true,
  seoEnabled = true,
  reviewEnabled = true,
  isImpersonated = false
}: {
  active: NavKey
  salonName: string | null
  styleEnabled?: boolean
  blogEnabled?: boolean
  seoEnabled?: boolean
  reviewEnabled?: boolean
  isImpersonated?: boolean
}) {
  const groups = NAV_GROUPS
  return (
    <aside class="w-64 bg-white border-r border-gray-100 min-h-screen p-5 hidden md:block">
      <div class="mb-8 text-center">
        <a href="/dashboard">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="inline-block h-9 w-auto" />
        </a>
      </div>

      {/* 複数サロンワークスペース対応: JSが2件以上の有効なサロンを検知した
          場合のみ切り替えUIを描画する(単一サロンのアカウントには何も出ない)。 */}
      <div id="salon-switcher-area" class="mb-4"></div>

      {groups.map((group) => {
        const items = NAV_ITEMS.filter(
          (item) => item.group === group.key && isNavItemVisible(item, styleEnabled, blogEnabled, seoEnabled, reviewEnabled, isImpersonated)
        )
        if (items.length === 0) return null
        return (
          <div class="mb-4">
            {group.title && (
              <p class="text-[11px] font-semibold text-gray-400 px-3 mb-1 mt-4">{group.title}</p>
            )}
            <nav class="space-y-1">
              {items.map((item) => (
                <a
                  href={item.href}
                  class={
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ' +
                    (item.key === active ? 'bg-pink-50 text-pink-600' : 'text-gray-600 hover:bg-gray-50')
                  }
                >
                  <i class={`fas ${item.icon} w-4`}></i>
                  <span>{item.label}</span>
                </a>
              ))}
            </nav>
          </div>
        )
      })}

      <form method="post" action="/logout" class="mt-4 px-1">
        <button type="submit" class="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-2">
          <i class="fas fa-arrow-right-from-bracket"></i> ログアウト
        </button>
      </form>
    </aside>
  )
}

function MobileNavPanel({
  active,
  styleEnabled,
  blogEnabled,
  seoEnabled,
  reviewEnabled,
  isImpersonated
}: {
  active: NavKey
  styleEnabled: boolean
  blogEnabled: boolean
  seoEnabled: boolean
  reviewEnabled: boolean
  isImpersonated: boolean
}) {
  return (
    <div class="fixed inset-0 z-50 bg-white overflow-y-auto">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span class="font-bold text-gray-900">メニュー</span>
        {/* ヘッダー側のハンバーガーボタンはこのパネルの下に隠れて押せなくなるため、
            パネル内に専用の閉じるボタンを用意する(<details>のopen属性を外して閉じる)。 */}
        <button
          type="button"
          onclick="this.closest('details').removeAttribute('open')"
          class="w-11 h-11 -mr-1 flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-50"
        >
          <i class="fas fa-xmark text-2xl"></i>
        </button>
      </div>
      <div class="p-4">
        <div id="salon-switcher-area-mobile" class="mb-2"></div>
        <div class="space-y-4">
          {NAV_GROUPS.map((group) => {
            const items = NAV_ITEMS.filter(
              (item) => item.group === group.key && isNavItemVisible(item, styleEnabled, blogEnabled, seoEnabled, reviewEnabled, isImpersonated)
            )
            if (items.length === 0 && group.key !== 'settings') return null
            return (
              <div>
                {group.title && <p class="text-[11px] font-semibold text-gray-400 px-2 mb-1">{group.title}</p>}
                <nav class="space-y-1">
                  {items.map((item) => (
                    <a
                      href={item.href}
                      class={
                        'flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition ' +
                        (item.key === active ? 'bg-pink-50 text-pink-600' : 'text-gray-600 hover:bg-gray-50')
                      }
                    >
                      <i class={`fas ${item.icon} w-4`}></i>
                      <span>{item.label}</span>
                    </a>
                  ))}
                  {group.key === 'settings' && (
                    <form method="post" action="/logout">
                      <button
                        type="submit"
                        class="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition text-gray-600 hover:bg-gray-50"
                      >
                        <i class="fas fa-arrow-right-from-bracket w-4"></i>
                        <span>ログアウト</span>
                      </button>
                    </form>
                  )}
                </nav>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function TopBar({
  title,
  active,
  styleEnabled = true,
  blogEnabled = true,
  seoEnabled = true,
  reviewEnabled = true,
  isImpersonated = false
}: {
  title: string
  active: NavKey
  styleEnabled?: boolean
  blogEnabled?: boolean
  seoEnabled?: boolean
  reviewEnabled?: boolean
  isImpersonated?: boolean
}) {
  return (
    <header class="sticky top-0 z-20 border-b border-gray-100 bg-white">
      <div class="md:hidden grid grid-cols-[1fr_auto_1fr] items-center px-4 py-3">
        <div></div>
        <a href="/dashboard" class="justify-self-center flex items-center">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="h-7 w-auto" />
        </a>
        <details class="relative justify-self-end">
          <summary class="list-none cursor-pointer w-11 h-11 -mr-1 flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-50">
            <span class="hamburger-icon relative inline-block w-4 h-2.5">
              <span class="hamburger-line absolute left-0 w-4 h-0.5 bg-current rounded-full"></span>
              <span class="hamburger-line absolute left-0 w-4 h-0.5 bg-current rounded-full"></span>
            </span>
          </summary>
          <MobileNavPanel
            active={active}
            styleEnabled={styleEnabled}
            blogEnabled={blogEnabled}
            seoEnabled={seoEnabled}
            reviewEnabled={reviewEnabled}
            isImpersonated={isImpersonated}
          />
        </details>
      </div>
      <div class="hidden md:flex items-center gap-3 px-6 py-4">
        <h1 class="text-lg font-bold text-gray-900">{title}</h1>
      </div>
    </header>
  )
}

function MobileGroupNav({ active }: { active: NavKey }) {
  const current = NAV_ITEMS.find((item) => item.key === active)
  if (!current || current.group === 'main' || current.group === 'settings') return null
  const items = NAV_ITEMS.filter((item) => item.group === current.group)
  return (
    <div class="md:hidden px-4 pt-4">
      <select
        class="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-medium text-gray-700 bg-white"
        onchange="location.href=this.value"
      >
        {items.map((item) => (
          <option value={item.href} selected={item.key === active}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function PageLayout({
  active,
  salonName,
  title,
  styleEnabled = true,
  blogEnabled = true,
  seoEnabled = true,
  reviewEnabled = true,
  isImpersonated = false,
  children
}: {
  active: NavKey
  salonName: string | null
  title: string
  styleEnabled?: boolean
  blogEnabled?: boolean
  seoEnabled?: boolean
  reviewEnabled?: boolean
  isImpersonated?: boolean
  children: any
}) {
  return (
    <div class="flex">
      <Sidebar
        active={active}
        salonName={salonName}
        styleEnabled={styleEnabled}
        blogEnabled={blogEnabled}
        seoEnabled={seoEnabled}
        reviewEnabled={reviewEnabled}
        isImpersonated={isImpersonated}
      />
      <div class="flex-1 min-w-0">
        <TopBar
          title={title}
          active={active}
          styleEnabled={styleEnabled}
          blogEnabled={blogEnabled}
          seoEnabled={seoEnabled}
          reviewEnabled={reviewEnabled}
          isImpersonated={isImpersonated}
        />
        <MobileGroupNav active={active} />
        <main class="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">{children}</main>
      </div>
      <script src="/static/salon-switcher.js"></script>
      <script src="/static/autosize-textarea.js"></script>
      <script src="/static/sync-modal.js"></script>
    </div>
  )
}
