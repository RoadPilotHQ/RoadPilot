import { useDashboard } from '@/state/DashboardProvider'
import { useI18n, type TranslationKey } from '@/i18n'
import { Card } from '../components/controls'
import { AssistanceCard } from '../dashboard/AssistanceCard'
import { AutopilotCard } from '../dashboard/AutopilotCard'
import { ControlCard } from '../dashboard/ControlCard'
import {
  DynamicsCard,
  EnvironmentCard,
  NavigationCard,
  PositionCard,
} from '../dashboard/DetailCards'
import { CurrentJobCard, RouteProgressCard } from '../dashboard/JobCards'
import { OverviewCards } from '../dashboard/OverviewCards'
import { VehicleDataCard } from '../dashboard/VehicleDataCard'
import type { PageId } from '../components/TopNav'

/** States whether the dashboard shows live telemetry or sample data, and why. */
function DataSourceBanner() {
  const { t } = useI18n()
  const { mode, connection, game, vehicle } = useDashboard().snapshot
  const params = { game: t(game ? `game.${game}` : 'game.any') }

  if (mode === 'live') {
    const interrupted = !vehicle
    return (
      <div className={interrupted ? 'demo-banner' : 'live-banner'} role="note">
        <strong>{t(interrupted ? 'mode.interrupted' : 'mode.live')}</strong>
        <span>{t(interrupted ? 'mode.interruptedHint' : 'mode.liveHint', params)}</span>
      </div>
    )
  }
  const reason: TranslationKey | null =
    connection === 'connecting'
      ? 'mode.hint.connecting'
      : connection === 'unavailable'
        ? 'mode.hint.unavailable'
        : connection === 'error'
          ? 'mode.hint.error'
          : null
  return (
    <div className="demo-banner" role="note">
      <strong>{t('mode.demo')}</strong>
      <span>{t('mode.demoHint')}</span>
      {reason ? <span className="banner-reason">{t(reason, params)}</span> : null}
    </div>
  )
}

export function DashboardPage() {
  return (
    <div className="dashboard">
      <DataSourceBanner />
      <ControlCard />
      <OverviewCards />
      <div className="grid">
        <VehicleDataCard />
        <AutopilotCard />
        <AssistanceCard />
        <CurrentJobCard />
        <RouteProgressCard />
        <DynamicsCard />
        <NavigationCard />
        <EnvironmentCard />
        <PositionCard />
      </div>
    </div>
  )
}

export function PlaceholderPage({ page }: { page: Exclude<PageId, 'dashboard'> }) {
  const { t } = useI18n()
  return (
    <div className="dashboard">
      <Card title={t(`page.${page}.title`)}>
        <p className="note">{t('common.comingSoon')}</p>
      </Card>
    </div>
  )
}
