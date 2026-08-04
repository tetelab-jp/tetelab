// 共通レイアウト（サイドバー・トップバー）
// 各ルート（dashboard/style/blog）から共有して利用する

export type NavKey =
  | 'dashboard'
  | 'settings'
  | 'style-library'
  | 'style-schedule'
  | 'style-template'
  | 'style-test-run'
  | 'blog-master'
  | 'blog-posts'

const NAV_ITEMS: { key: NavKey; href: string; icon: string; label: string; group: 'main' | 'style' | 'blog' }[] = [
  { key: 'dashboard', href: '/dashboard', icon: 'fa-gauge-high', label: 'ダッシュボード', group: 'main' },
  { key: 'settings', href: '/settings/salonboard', icon: 'fa-key', label: 'サロンボード連携設定', group: 'main' },
  { key: 'style-library', href: '/style/library', icon: 'fa-images', label: '画像ライブラリ', group: 'style' },
  { key: 'style-template', href: '/style/template', icon: 'fa-sliders', label: '投稿テンプレート設定', group: 'style' },
  { key: 'style-schedule', href: '/style/schedule', icon: 'fa-clock', label: '自動投稿スケジュール', group: 'style' },
  { key: 'style-test-run', href: '/style/test-run', icon: 'fa-flask', label: 'テスト実行・実行履歴', group: 'style' },
  { key: 'blog-master', href: '/blog/master', icon: 'fa-sliders', label: 'ブログ基本設定', group: 'blog' },
  { key: 'blog-posts', href: '/blog/posts', icon: 'fa-pen-to-square', label: 'ブログ投稿作成', group: 'blog' }
]

export function Sidebar({ active, salonName }: { active: NavKey; salonName: string | null }) {
  const groups: { title: string; key: 'main' | 'style' | 'blog' }[] = [
    { title: '', key: 'main' },
    { title: 'スタイル投稿', key: 'style' },
    { title: 'ブログ投稿', key: 'blog' }
  ]
  return (
    <aside class="w-64 bg-white border-r border-gray-100 min-h-screen p-5 hidden md:block">
      <div class="flex items-center gap-2 mb-8 px-1">
        <div class="w-9 h-9 rounded-xl bg-pink-500 text-white flex items-center justify-center">
          <i class="fas fa-scissors"></i>
        </div>
        <div>
          <p class="font-bold text-sm leading-tight">TETE AOUT</p>
          <p class="text-xs text-gray-400 leading-tight">{salonName || 'マイページ'}</p>
        </div>
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

export function TopBar({ title }: { title: string }) {
  return (
    <header class="border-b border-gray-100 bg-white px-6 py-4 flex items-center justify-between">
      <h1 class="text-lg font-bold text-gray-900">{title}</h1>
    </header>
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
        <TopBar title={title} />
        <main class="p-6 space-y-6">{children}</main>
      </div>
    </div>
  )
}
