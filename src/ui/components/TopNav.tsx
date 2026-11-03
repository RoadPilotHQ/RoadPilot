import { Info, LayoutDashboard, ScrollText, Settings, Truck, Waypoints } from 'lucide-react'
import type { ComponentType } from 'react'
import type { ConnectionState, GameId } from '@/domain/types'
import { useI18n, type TranslationKey } from '@/i18n'
import { Logo } from './Logo'

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
  reconnecting: 'connection.reconnecting',
  unavailable: 'connection.unavailable',
  error: 'connection.error',
}

export function ConnectionBadge({
  state,
  game,
  paused = false,
}: {
  state: ConnectionState
  game: GameId | null
  paused?: boolean
}) {
  const { t } = useI18n()
  const key = state === 'connected' && paused ? 'connection.paused' : CONNECTION_KEYS[state]
  return (
    <div className={`connection connection-${state}`} role="status">
      <Truck size={16} aria-hidden />
      <span>{t(key, { game: t(game ? `game.${game}` : 'game.any') })}</span>
      <span className="connection-dot" aria-hidden />
    </div>
  )
}

export function TopNav({
  page,
  onNavigate,
  connection,
  game = null,
  paused = false,
}: {
  page: PageId
  onNavigate: (page: PageId) => void
  connection: ConnectionState
  game?: GameId | null
  paused?: boolean
}) {
  const { t } = useI18n()
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
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
      <ConnectionBadge state={connection} game={game} paused={paused} />
    </header>
  )
}
