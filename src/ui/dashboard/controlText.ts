import type {
  CommandReply,
  ControlStatus,
  LogEntry,
  OperatorCommand,
  Reason,
  Rejection,
  SafetyEvent,
  Withheld,
} from '@/domain/control'
import type { TranslationKey } from '@/i18n'
import type { Params } from '@/i18n/translate'

type T = (key: TranslationKey, params?: Params) => string

const COMMAND_KEYS: Record<OperatorCommand, TranslationKey> = {
  arm: 'control.action.arm',
  activate: 'control.action.activate',
  disarm: 'control.action.disarm',
  resetFault: 'control.action.resetFault',
}

export const commandText = (t: T, command: OperatorCommand) => t(COMMAND_KEYS[command])

export const safetyText = (t: T, event: SafetyEvent) => t(`control.event.${event.code}`)

export function reasonText(t: T, reason: Reason): string {
  return reason.code === 'safety' ? safetyText(t, reason.event) : t(`control.reason.${reason.code}`)
}

export function rejectionText(t: T, rejection: Rejection): string {
  return rejection.code === 'safety' && rejection.event
    ? safetyText(t, rejection.event)
    : t(`control.rejection.${rejection.code}`)
}

export const withheldText = (t: T, withheld: Withheld) => t(`control.withheld.${withheld.code}`)

export function replyText(t: T, reply: CommandReply): string {
  const command = commandText(t, reply.command)
  switch (reply.outcome) {
    case 'accepted':
      return t('control.reply.accepted', { command })
    case 'rejected':
      return t('control.reply.rejected', {
        command,
        reason: reply.rejection ? rejectionText(t, reply.rejection) : '',
      })
    case 'pending':
      return t('control.reply.pending', { command })
    case 'unavailable':
      return t('control.reply.unavailable', { command })
  }
}

/** One line describing a decision log entry. */
export function decisionText(t: T, entry: LogEntry): string {
  switch (entry.event) {
    case 'transition':
      return t('control.decision.transition', {
        from: entry.from ? t(`control.state.${entry.from}`) : '',
        to: entry.to ? t(`control.state.${entry.to}`) : '',
        reason: reasonText(t, entry.reason as Reason),
      })
    case 'epoch':
      return t('control.decision.epoch', {
        epoch: entry.epoch ?? 0,
        cause: entry.cause ? t(`control.cause.${entry.cause}`) : '',
      })
    case 'frameInvalid':
      return t('control.decision.frameInvalid', { reason: String(entry.reason ?? '') })
    case 'withheld':
      return t('control.decision.withheld', { reason: withheldText(t, entry.reason as Withheld) })
    case 'commandRejected':
      return t('control.decision.commandRejected', {
        command: entry.command ? commandText(t, entry.command) : '',
        reason: entry.rejection ? rejectionText(t, entry.rejection) : '',
      })
    case 'watchdogTripped':
      return t('control.decision.watchdogTripped', { silent: entry.silentMs ?? 0 })
    case 'feedLost':
      return t('control.decision.feedLost')
    case 'feedRestored':
      return t('control.decision.feedRestored')
    case 'shutdown':
      return t('control.decision.shutdown', {
        disarm: t(`control.disarmStatus.${entry.disarm ?? 'notRequired'}`),
      })
    default:
      return entry.event
  }
}

/** Seconds between a status's `nowMs` and an earlier `atMs`, one decimal. */
export function secondsAgo(status: ControlStatus, atMs: number): string {
  return (Math.max(0, status.nowMs - atMs) / 1000).toFixed(1)
}

/**
 * The three stages of the last tick's output. A command is generated and encoded; a disarm is
 * encoded but not generated from a request; nothing is ever transmitted in dry run.
 */
export interface OutputStages {
  kind: 'idle' | 'command' | 'disarm' | 'withheld'
  generated: boolean
  encoded: boolean
  withheld: Withheld | null
}

export function outputStages(status: ControlStatus): OutputStages {
  const outcome = status.lastTick?.outcome
  switch (outcome?.code) {
    case 'commandEncoded':
      return { kind: 'command', generated: true, encoded: true, withheld: null }
    case 'disarmEncoded':
      return { kind: 'disarm', generated: false, encoded: true, withheld: null }
    case 'withheld':
      return { kind: 'withheld', generated: false, encoded: false, withheld: outcome.reason }
    default:
      return { kind: 'idle', generated: false, encoded: false, withheld: null }
  }
}
