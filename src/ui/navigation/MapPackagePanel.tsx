import { useState } from 'react'
import { useDashboard } from '@/state/DashboardProvider'
import { useMap } from '@/state/MapProvider'
import type { MapStatus } from '@/domain/map'
import type { GameId } from '@/domain/types'
import { Segmented } from '../components/controls'
import { useVehicleFormat } from '../vehicle/format'

const GAMES: readonly GameId[] = ['ets2', 'ats']

/** One line on the state of the map, without directory paths. */
export function useMapStatusText() {
  const f = useVehicleFormat()
  return (status: MapStatus | null, hasFolder: boolean): string => {
    if (!status || status.state === 'none')
      return f.t(hasFolder ? 'map.status.none' : 'map.status.noPackage')
    switch (status.state) {
      case 'selecting':
        return f.t('map.status.selecting')
      case 'loading':
        return f.t(status.phase === 'preparing' ? 'map.status.preparing' : 'map.status.loading')
      case 'ready':
        return f.t('map.status.ready', {
          roads: f.number(status.counts?.roads ?? 0),
          seconds: f.number((status.loadMs ?? 0) / 1000, 1),
        })
      case 'game_mismatch':
        return f.t('map.status.gameMismatch', {
          packageGame: status.packageGame ?? '?',
          game: f.t(`game.${status.game ?? 'any'}`),
        })
      case 'unsupported_version':
        return f.t('map.status.unsupported', { version: status.schema ?? '?' })
      case 'error':
        return f.t('map.status.error', { detail: status.error?.detail ?? '' })
    }
  }
}

/**
 * Where the user names the folder of a map package per game. RoadPilot never searches for game
 * installations and never generates packages; the folder is only read.
 */
export function MapPackagePanel() {
  const f = useVehicleFormat()
  const { setMapPackage, setMapGame } = useDashboard()
  const { map, game, gameFromTelemetry, folder, reload } = useMap()
  const [draft, setDraft] = useState<{ game: GameId; text: string } | null>(null)
  const text = draft?.game === game ? draft.text : (folder ?? '')
  const statusText = useMapStatusText()
  const status = map.status?.game === game ? map.status : null
  const state = status?.state ?? 'none'

  if (!map.available) {
    return (
      <details className="map-package">
        <summary>{f.t('map.package.title')}</summary>
        <p className="note">{f.t('map.unavailable')}</p>
      </details>
    )
  }

  const save = () => {
    setMapPackage(game, text.trim() === '' ? null : text.trim())
    setDraft(null)
  }

  return (
    <details className="map-package" open={!folder || state !== 'ready'}>
      <summary>
        {f.t('map.package.title')}
        <span className={`map-state map-state-${state}`}>{statusText(status, !!folder)}</span>
      </summary>
      <div className="map-package-body">
        <div className="map-package-game">
          <span className="label">{f.t('map.package.game')}</span>
          {gameFromTelemetry ? (
            <strong>{f.t('map.package.gameFromTelemetry', { game: f.t(`game.${game}`) })}</strong>
          ) : (
            <Segmented<GameId>
              label={f.t('map.package.game')}
              value={game}
              onChange={setMapGame}
              options={GAMES.map((g) => ({ value: g, label: f.t(`game.${g}`) }))}
            />
          )}
        </div>
        <label className="map-package-folder">
          <span className="label">{f.t('map.package.folder', { game: f.t(`game.${game}`) })}</span>
          <input
            type="text"
            spellCheck={false}
            value={text}
            placeholder={f.t('map.package.placeholder')}
            onChange={(e) => setDraft({ game, text: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
        </label>
        <div className="map-package-actions">
          <button type="button" className="control-button" onClick={save}>
            {f.t('map.package.use')}
          </button>
          <button type="button" className="control-button" onClick={reload} disabled={!folder}>
            {f.t('map.package.reload')}
          </button>
          <button
            type="button"
            className="control-button"
            onClick={() => {
              setMapPackage(game, null)
              setDraft(null)
            }}
            disabled={!folder}
          >
            {f.t('map.package.remove')}
          </button>
        </div>
        {status?.state === 'ready' && status.contentId ? (
          <p className="note">
            {f.t('map.package.details', {
              id: status.contentId,
              schema: status.schema ?? '?',
              roads: f.number(status.counts?.roads ?? 0),
              nodes: f.number(status.counts?.nodes ?? 0),
            })}
          </p>
        ) : null}
        <p className="note">{f.t('map.package.howTo')}</p>
        <code className="map-package-command">
          roadpilot-map build-package --game {game} --game-dir &lt;game folder&gt; --out &lt;package
          folder&gt;
        </code>
        <p className="note">{f.t('map.package.localOnly')}</p>
      </div>
    </details>
  )
}
