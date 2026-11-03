import { useState } from 'react'
import { I18nProvider } from '@/i18n'
import { DashboardProvider, useDashboard } from '@/state/DashboardProvider'
import { TopNav, type PageId } from '@/ui/components/TopNav'
import { DashboardPage, PlaceholderPage } from '@/ui/pages/pages'
import type { DashboardSource } from '@/backend/dashboardSource'

function Shell() {
  const [page, setPage] = useState<PageId>('dashboard')
  const { connection, game, paused } = useDashboard().snapshot
  return (
    <div className="window">
      <TopNav
        page={page}
        onNavigate={setPage}
        connection={connection}
        game={game}
        paused={paused}
      />
      <main className="content">
        {page === 'dashboard' ? <DashboardPage /> : <PlaceholderPage page={page} />}
      </main>
    </div>
  )
}

export function App({ source }: { source?: DashboardSource }) {
  return (
    <I18nProvider>
      <DashboardProvider source={source}>
        <Shell />
      </DashboardProvider>
    </I18nProvider>
  )
}
