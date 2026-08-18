// 管理者サイト(/admin)共通レイアウト。サロン側のPageLayout(components/layout.tsx)
// とビジュアルトーンは合わせつつ、ナビ項目・ログアウト先はadmin専用にするため
// 別コンポーネントとして分離している(NavKeyがサロン側ルートに固定されているため)。

export type AdminNavKey = 'admin-salons' | 'admin-tool' | 'admin-status'

const ADMIN_NAV_ITEMS: { key: AdminNavKey; href: string; icon: string; label: string }[] = [
  { key: 'admin-salons', href: '/admin/salons', icon: 'fa-store', label: '契約サロン一覧' },
  { key: 'admin-tool', href: '/admin/tool', icon: 'fa-toggle-on', label: '機能設定' },
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

// 2026-08-18追記(ユーザー指定バグ修正): AdminSidebarはPC限定表示(hidden md:block)
// のみで、モバイル側に代わりのナビゲーションが一切無かった。サロン側の
// PageLayout(components/layout.tsx)と同じ「ハンバーガー→フルスクリーンの
// メニューパネル」方式を導入し、モバイルでもページ間を移動・ログアウトできるようにする。
function AdminMobileNavPanel({ active, adminEmail }: { active: AdminNavKey; adminEmail: string }) {
  return (
    <div class="fixed inset-0 z-50 bg-white overflow-y-auto">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span class="font-bold text-gray-900">メニュー</span>
        <button
          type="button"
          onclick="this.closest('details').removeAttribute('open')"
          class="w-11 h-11 -mr-1 flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-50"
        >
          <i class="fas fa-xmark text-2xl"></i>
        </button>
      </div>
      <div class="p-4">
        <p class="text-[11px] font-semibold text-gray-400 px-2 mb-1">{adminEmail}</p>
        <nav class="space-y-1">
          {ADMIN_NAV_ITEMS.map((item) => (
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
          <form method="post" action="/admin/logout">
            <button
              type="submit"
              class="w-full flex items-center gap-3 px-2 py-2.5 rounded-lg text-sm font-medium transition text-gray-600 hover:bg-gray-50"
            >
              <i class="fas fa-arrow-right-from-bracket w-4"></i>
              <span>ログアウト</span>
            </button>
          </form>
        </nav>
      </div>
    </div>
  )
}

function AdminTopBar({ title, active, adminEmail }: { title: string; active: AdminNavKey; adminEmail: string }) {
  return (
    <header class="sticky top-0 z-20 border-b border-gray-100 bg-white">
      <div class="md:hidden grid grid-cols-[1fr_auto_1fr] items-center px-4 py-3">
        <div></div>
        <a href="/admin/salons" class="justify-self-center flex items-center">
          <img src="/static/logo-combined.png" alt="SalonMotion" class="h-7 w-auto" />
        </a>
        <details class="relative justify-self-end">
          <summary class="list-none cursor-pointer w-11 h-11 -mr-1 flex items-center justify-center rounded-lg text-gray-600 hover:bg-gray-50">
            <span class="hamburger-icon relative inline-block w-4 h-2.5">
              <span class="hamburger-line absolute left-0 w-4 h-0.5 bg-current rounded-full"></span>
              <span class="hamburger-line absolute left-0 w-4 h-0.5 bg-current rounded-full"></span>
            </span>
          </summary>
          <AdminMobileNavPanel active={active} adminEmail={adminEmail} />
        </details>
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
        <AdminTopBar title={title} active={active} adminEmail={adminEmail} />
        <main class="p-4 sm:p-6 space-y-6 max-w-[1600px] mx-auto">{children}</main>
      </div>
    </div>
  )
}
