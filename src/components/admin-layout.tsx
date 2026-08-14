// 管理者サイト(/admin)共通レイアウト。サロン側のPageLayout(components/layout.tsx)
// とビジュアルトーンは合わせつつ、ナビ項目・ログアウト先はadmin専用にするため
// 別コンポーネントとして分離している(NavKeyがサロン側ルートに固定されているため)。

export type AdminNavKey = 'admin-salons' | 'admin-tool' | 'admin-status'

const ADMIN_NAV_ITEMS: { key: AdminNavKey; href: string; icon: string; label: string }[] = [
  { key: 'admin-salons', href: '/admin/salons', icon: 'fa-store', label: 'サロン一覧' },
  { key: 'admin-tool', href: '/admin/tool', icon: 'fa-toggle-on', label: '契約設定' },
  { key: 'admin-status', href: '/admin/status', icon: 'fa-heart-pulse', label: '稼働状況' }
]

function AdminSidebar({ active, adminEmail }: { active: AdminNavKey; adminEmail: string }) {
  return (
    <aside class="w-64 bg-white border-r border-gray-100 min-h-screen p-5 hidden md:block">
      <div class="mb-8 text-center">
        <img src="/static/logo-combined.png" alt="SalonMotion" class="inline-block h-9 w-auto" />
        <p class="text-[11px] font-semibold text-gray-400 mt-1">管理者サイト</p>
      </div>

      <p class="text-[11px] font-semibold text-gray-400 px-3 mb-1">{adminEmail}</p>
      <nav class="space-y-1 mb-6">
        {ADMIN_NAV_ITEMS.map((item) => (
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

      <form method="post" action="/admin/logout" class="mt-4 px-1">
        <button type="submit" class="text-sm text-gray-400 hover:text-gray-600 flex items-center gap-2">
          <i class="fas fa-arrow-right-from-bracket"></i> ログアウト
        </button>
      </form>
    </aside>
  )
}

function AdminTopBar({ title }: { title: string }) {
  return (
    <header class="sticky top-0 z-20 border-b border-gray-100 bg-white">
      <div class="md:hidden flex items-center justify-between px-4 py-3">
        <a href="/admin/salons" class="flex items-center">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="h-7 w-auto" />
        </a>
        <span class="text-xs font-semibold text-gray-400">管理者</span>
      </div>
      <div class="hidden md:flex items-center gap-3 px-6 py-4">
        <h1 class="text-lg font-bold text-gray-900">{title}</h1>
      </div>
    </header>
  )
}

export function AdminPageLayout({
  active,
  adminEmail,
  title,
  children
}: {
  active: AdminNavKey
  adminEmail: string
  title: string
  children: any
}) {
  return (
    <div class="flex">
      <AdminSidebar active={active} adminEmail={adminEmail} />
      <div class="flex-1 min-w-0">
        <AdminTopBar title={title} />
        <main class="p-6 space-y-6">{children}</main>
      </div>
    </div>
  )
}
