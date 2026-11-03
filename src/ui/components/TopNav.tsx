import { Info, LayoutDashboard, ScrollText, Settings, Truck, Waypoints } from 'lucide-react'
import type { ComponentType } from 'react'
import type { ConnectionState } from '@/domain/types'
import { useI18n, type TranslationKey } from '@/i18n'

export const PAGES = ['dashboard', 'driving', 'settings', 'logs', 'about'] as const
export type PageId = (typeof PAGES)[number]

const PAGE_ICONS: Record<PageId, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  dashboard: LayoutDashboard,
  driving: Waypoints,
  settings: Settings,
  logs: ScrollText,
  about: Info,
}

const CONNECTION_KEYS: Record<ConnectionState, TranslationKey> = {
  connected: 'connection.connected',
  disconnected: 'connection.disconnected',
  connecting: 'connection.connecting',
  error: 'connection.error',
}

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { t } = useI18n()
  return (
    <div className={`connection connection-${state}`} role="status">
      <Truck size={16} aria-hidden />
      <span>{t(CONNECTION_KEYS[state])}</span>
      <span className="connection-dot" aria-hidden />
    </div>
  )
}

function Logo() {
  return (
    <svg width="34" height="26" viewBox="0 0 34 26" aria-hidden>
      <path d="M2 24 13 2l5 0L8 24Z" fill="#e8792e" />
      <path d="M12 24 21 6l4 0 7 18h-6l-3-8-3 8Z" fill="#f19a52" />
      <path d="M16 24l2-5 3 0 1 5Z" fill="#292724" />
    </svg>
  )
}

export function TopNav({
  page,
  onNavigate,
  connection,
}: {
  page: PageId
  onNavigate: (page: PageId) => void
  connection: ConnectionState
}) {
  const { t } = useI18n()
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span className="brand-name">{t('app.name')}</span>
      </div>
      <nav className="nav" aria-label={t('nav.label')}>
        {PAGES.map((id) => {
          const Icon = PAGE_ICONS[id]
          return (
            <button
              key={id}
              type="button"
              className="nav-item"
              aria-current={id === page ? 'page' : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon size={15} aria-hidden />
              {t(`nav.${id}`)}
            </button>
          )
        })}
      </nav>
      <ConnectionBadge state={connection} />
    </header>
  )
}
