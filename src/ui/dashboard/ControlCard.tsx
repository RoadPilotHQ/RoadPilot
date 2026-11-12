import type { ControlStatus, OperatorCommand } from '@/domain/control'
import { useI18n } from '@/i18n'
import { useControl } from '@/state/ControlProvider'
import {
  decisionText,
  outputStages,
  replyText,
  safetyText,
  secondsAgo,
  withheldText,
} from './controlText'

const RECENT = 5

/**
 * Status and operator commands of the dry-run control pipeline.
 *
 * The UI is never the safety authority: every button only sends a request, and the backend
 * supervisor accepts or refuses it. Disarm is always rendered, always enabled, and needs no
 * confirmation; it is the first control in the section so it stays in the same place.
 */
export function ControlCard() {
  const { t } = useI18n()
  const { snapshot, request } = useControl()
  const { status, lastReply, pending } = snapshot
  const running = status?.runtime === 'running'
  const state = status?.state ?? 'disabled'
  const send = (command: OperatorCommand) => {
    void request(command)
  }

  return (
    <section className="card control-card" aria-label={t('control.title')}>
      <div className="control-header">
        <h2 className="card-title">{t('control.title')}</h2>
        <span
          className={`control-state control-state-${state}`}
          aria-label={t('control.state.label')}
        >
          {t(`control.state.${state}`)}
        </span>
        <span className="tag control-mode">{t('control.mode.dryRun')}</span>
      </div>

      <div className="control-actions" role="group" aria-label={t('control.actions')}>
        <button
          type="button"
          className="control-button control-disarm"
          onClick={() => send('disarm')}
          aria-describedby="control-disarm-hint"
        >
          {t('control.action.disarm')}
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!running || state !== 'disabled'}
          onClick={() => send('arm')}
        >
          {t('control.action.arm')}
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!running || state !== 'armed'}
          onClick={() => send('activate')}
        >
          {t('control.action.activate')}
        </button>
        <button
          type="button"
          className="control-button"
          disabled={!running || state !== 'fault'}
          onClick={() => send('resetFault')}
        >
          {t('control.action.resetFault')}
        </button>
        <span id="control-disarm-hint" className="control-hint">
          {t('control.disarmHint')}
        </span>
      </div>

      <p className="control-reply" aria-live="polite">
        {lastReply && !pending ? replyText(t, lastReply) : ' '}
      </p>

      {status && running ? (
        <ControlDetails status={status} />
      ) : (
        <p className="note">
          {t(
            status?.runtime === 'stopped'
              ? 'control.runtime.stopped'
              : 'control.runtime.unavailable',
          )}
        </p>
      )}

      <p className="note">{t('control.dryRunNote')}</p>
    </section>
  )
}

function ControlDetails({ status }: { status: ControlStatus }) {
  const { t } = useI18n()
  const { telemetry, watchdog, lastSafetyEvent, lastTick } = status

  const connection = !telemetry.feedConnected
    ? t('control.connection.noChannel')
    : telemetry.game
      ? t('control.connection.connected', { game: t(`game.${telemetry.game}`) })
      : t('control.connection.noData')

  const freshnessStatus = t(`control.freshness.${telemetry.freshness}`)
  const freshness =
    telemetry.frameAgeMs == null
      ? freshnessStatus
      : t('control.freshness.withAge', { status: freshnessStatus, age: telemetry.frameAgeMs })

  const safety = lastSafetyEvent
    ? t('control.ago', {
        text: safetyText(t, lastSafetyEvent),
        seconds: secondsAgo(status, lastSafetyEvent.atMs),
      })
    : t('control.none')

  const tick = lastTick
    ? t('control.tick.value', {
        sequence: lastTick.sequence,
        verdict: t(`control.verdict.${lastTick.verdict}`),
        lateness: lastTick.latenessMs.toFixed(1),
      })
    : t('control.tick.none')

  const watchdogText = watchdog.tripPending
    ? t('control.watchdog.tripped')
    : watchdog.loopSilentMs > watchdog.timeoutMs
      ? t('control.watchdog.silent', { silent: watchdog.loopSilentMs })
      : t('control.watchdog.ok', { silent: watchdog.loopSilentMs })

  const stages = outputStages(status)
  const outputText =
    stages.kind === 'command'
      ? t('control.output.command')
      : stages.kind === 'disarm'
        ? t('control.output.disarm')
        : stages.kind === 'withheld' && stages.withheld
          ? t('control.output.withheld', { reason: withheldText(t, stages.withheld) })
          : t('control.output.idle')

  const { intervals } = status.timing
  const timingText =
    intervals.count === 0
      ? t('control.timing.none')
      : t('control.timing.value', {
          p99: intervals.p99Ms.toFixed(1),
          p999: intervals.p999Ms.toFixed(1),
          max: intervals.maxMs.toFixed(1),
          over50: intervals.over50,
        })

  const decisions = status.recentDecisions.slice(0, RECENT)

  return (
    <>
      <ul className="rows control-rows">
        <ControlRow label={t('control.row.connection')} value={connection} />
        <ControlRow label={t('control.row.freshness')} value={freshness} />
        <ControlRow label={t('control.row.epoch')} value={String(telemetry.epoch)} />
        <ControlRow label={t('control.row.safety')} value={safety} />
        <ControlRow label={t('control.row.tick')} value={tick} />
        <ControlRow label={t('control.row.timing')} value={timingText} />
        <ControlRow
          label={t('control.row.watchdog')}
          value={
            watchdog.trips > 0
              ? `${watchdogText} · ${t('control.watchdog.trips', { count: watchdog.trips })}`
              : watchdogText
          }
        />
        <li className="row">
          <span className="row-label">{t('control.row.output')}</span>
          <span className="row-value control-output">
            <span>{outputText}</span>
            {stages.kind === 'command' || stages.kind === 'disarm' ? (
              <span className="control-stages">
                <span className={`tag ${stages.generated ? 'stage-done' : ''}`}>
                  {t(stages.generated ? 'control.stage.generated' : 'control.stage.notGenerated')}
                </span>
                <span className={`tag ${stages.encoded ? 'stage-done' : ''}`}>
                  {t(stages.encoded ? 'control.stage.encoded' : 'control.stage.notEncoded')}
                </span>
                <span className="tag stage-dry-run">{t('control.stage.notTransmitted')}</span>
              </span>
            ) : null}
          </span>
        </li>
      </ul>

      <div className="sub-heading">{t('control.decisions')}</div>
      {decisions.length === 0 ? (
        <p className="note">{t('control.decisions.none')}</p>
      ) : (
        <ol className="control-decisions" aria-label={t('control.decisions')}>
          {decisions.map((entry) => (
            <li key={entry.n}>
              <span className="control-decision-time">-{secondsAgo(status, entry.atMs)} s</span>
              <span>{decisionText(t, entry)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

function ControlRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </li>
  )
}
