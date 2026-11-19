import { useState } from 'react'
import { I18nProvider } from '@/i18n'
import { ControlProvider } from '@/state/ControlProvider'
import { DashboardProvider, useDashboard } from '@/state/DashboardProvider'
import { MapProvider } from '@/state/MapProvider'
import { TopNav, type PageId } from '@/ui/components/TopNav'
import { DashboardPage, PlaceholderPage } from '@/ui/pages/pages'
import type { DashboardSource } from '@/backend/dashboardSource'
import type { ControlSource } from '@/backend/controlSource'
import type { MapSource } from '@/backend/mapSource'

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

export function App({
  source,
  controlSource,
  mapSource,
}: {
  source?: DashboardSource
  controlSource?: ControlSource
  mapSource?: MapSource
}) {
  return (
    <I18nProvider>
      <DashboardProvider source={source}>
        <ControlProvider source={controlSource}>
          <MapProvider source={mapSource}>
            <Shell />
          </MapProvider>
        </ControlProvider>
      </DashboardProvider>
    </I18nProvider>
  )
}
