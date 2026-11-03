import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { Card } from '../components/controls'
import { AssistanceCard } from '../dashboard/AssistanceCard'
import { AutopilotCard } from '../dashboard/AutopilotCard'
import { CurrentJobCard, RouteProgressCard } from '../dashboard/JobCards'
import { OverviewCards } from '../dashboard/OverviewCards'
import { VehicleDataCard } from '../dashboard/VehicleDataCard'
import type { PageId } from '../components/TopNav'

export function DashboardPage() {
  const { t } = useI18n()
  const { mode } = useDashboard().snapshot
  return (
    <div className="dashboard">
      {mode === 'demo' ? (
        <div className="demo-banner" role="note">
          <strong>{t('mode.demo')}</strong>
          <span>{t('mode.demoHint')}</span>
        </div>
      ) : null}
      <OverviewCards />
      <div className="grid">
        <VehicleDataCard />
        <AutopilotCard />
        <AssistanceCard />
        <CurrentJobCard />
        <RouteProgressCard />
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
