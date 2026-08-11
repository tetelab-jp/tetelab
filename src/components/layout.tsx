// 共通レイアウト（サイドバー・トップバー）
// 各ルート（dashboard/style/blog）から共有して利用する

export type NavKey =
  | 'dashboard'
  | 'settings'
  | 'style-library'
  | 'style-import'
  | 'style-schedule'
  | 'style-template'
  | 'style-test-run'
  | 'blog-master'
  | 'blog-posts'

const NAV_ITEMS: { key: NavKey; href: string; icon: string; label: string; group: 'main' | 'style' | 'blog' }[] = [
  { key: 'dashboard', href: '/dashboard', icon: 'fa-gauge-high', label: 'ダッシュボード', group: 'main' },
  { key: 'settings', href: '/settings/salonboard', icon: 'fa-key', label: 'サロンボード連携設定', group: 'main' },
  { key: 'style-library', href: '/style/library', icon: 'fa-images', label: '画像ライブラリ', group: 'style' },
  { key: 'style-import', href: '/style/import', icon: 'fa-cloud-arrow-down', label: '既存スタイル取り込み', group: 'style' },
  { key: 'style-template', href: '/style/template', icon: 'fa-sliders', label: '投稿テンプレート設定', group: 'style' },
  { key: 'style-schedule', href: '/style/schedule', icon: 'fa-clock', label: '自動投稿スケジュール', group: 'style' },
  { key: 'style-test-run', href: '/style/test-run', icon: 'fa-flask', label: '手動実行・実行履歴', group: 'style' },
  { key: 'blog-master', href: '/blog/master', icon: 'fa-sliders', label: 'ブログ基本設定', group: 'blog' },
  { key: 'blog-posts', href: '/blog/posts', icon: 'fa-pen-to-square', label: 'ブログ投稿作成', group: 'blog' }
]

const NAV_GROUPS: { title: string; key: 'main' | 'style' | 'blog' }[] = [
  { title: '', key: 'main' },
  { title: 'スタイル投稿', key: 'style' },
  { title: 'ブログ投稿', key: 'blog' }
]

export function Sidebar({ active, salonName }: { active: NavKey; salonName: string | null }) {
  const groups = NAV_GROUPS
  return (
    <aside class="w-64 bg-white border-r border-gray-100 min-h-screen p-5 hidden md:block">
      <div class="mb-8 text-center">
        <img src="/static/logo-combined.png" alt="SalonMotion" class="inline-block h-9 w-auto" />
      </div>

      {groups.map((group) => (
        <div class="mb-4">
          {group.title && (
            <p class="text-[11px] font-semibold text-gray-400 px-3 mb-1 mt-4">{group.title}</p>
          )}
          <nav class="space-y-1">
            {NAV_ITEMS.filter((item) => item.group === group.key).map((item) => (
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
      ))}

      <form method="post" action="/logout" class="mt-4 px-1">
        <button type="submit" class="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-2">
          <i class="fas fa-arrow-right-from-bracket"></i> ログアウト
        </button>
      </form>
    </aside>
  )
}

function MobileNavPanel({ active }: { active: NavKey }) {
  return (
    <div class="absolute left-0 top-full mt-2 w-72 bg-white border border-gray-100 rounded-xl shadow-lg p-3 z-30">
      <div class="space-y-4">
        {NAV_GROUPS.filter((group) => group.key !== 'main').map((group) => (
          <div>
            <p class="text-[11px] font-semibold text-gray-400 px-2 mb-1">{group.title}</p>
            <nav class="space-y-1">
              {NAV_ITEMS.filter((item) => item.group === group.key).map((item) => (
                <a
                  href={item.href}
                  class={
                    'flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium transition ' +
                    (item.key === active ? 'bg-pink-50 text-pink-600' : 'text-gray-600 hover:bg-gray-50')
                  }
                >
                  <i class={`fas ${item.icon} w-4`}></i>
                  <span>{item.label}</span>
                </a>
              ))}
            </nav>
          </div>
        ))}
        <div>
          <a
            href="/settings/salonboard"
            class={
              'flex items-center gap-3 px-2 py-2 rounded-lg text-sm font-medium transition ' +
              (active === 'settings' ? 'bg-pink-50 text-pink-600' : 'text-gray-600 hover:bg-gray-50')
            }
          >
            <i class="fas fa-key w-4"></i>
            <span>サロンボード連携</span>
          </a>
        </div>
      </div>
    </div>
  )
}

export function TopBar({ title, active }: { title: string; active: NavKey }) {
  return (
    <header class="sticky top-0 z-20 border-b border-gray-100 bg-white">
      <div class="flex items-center gap-3 px-4 py-3 md:px-6 md:py-4">
        <details class="md:hidden relative">
          <summary class="list-none cursor-pointer w-9 h-9 -ml-1 flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-50">
            <i class="fas fa-bars text-lg"></i>
          </summary>
          <MobileNavPanel active={active} />
        </details>
        <a href="/dashboard" class="md:hidden flex items-center">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="h-6 w-auto" />
        </a>
        <h1 class="text-lg font-bold text-gray-900">{title}</h1>
      </div>
    </header>
  )
}

function MobileGroupNav({ active }: { active: NavKey }) {
  const current = NAV_ITEMS.find((item) => item.key === active)
  if (!current || current.group === 'main') return null
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

function MobileLogoutBar() {
  return (
    <div class="md:hidden fixed bottom-0 inset-x-0 z-10 bg-white border-t border-gray-100 px-4 py-2">
      <form method="post" action="/logout">
        <button
          type="submit"
          class="w-full flex items-center justify-center gap-2 py-2 text-sm text-gray-500 hover:text-gray-700"
        >
          <i class="fas fa-arrow-right-from-bracket"></i> ログアウト
        </button>
      </form>
    </div>
  )
}

export function PageLayout({
  active,
  salonName,
  title,
  children
}: {
  active: NavKey
  salonName: string | null
  title: string
  children: any
}) {
  return (
    <div class="flex">
      <Sidebar active={active} salonName={salonName} />
      <div class="flex-1 min-w-0">
        <TopBar title={title} active={active} />
        <MobileGroupNav active={active} />
        <main class="p-6 pb-20 md:pb-6 space-y-6">{children}</main>
      </div>
      <MobileLogoutBar />
    </div>
  )
}
