import type { ReactNode } from 'react'
import { useI18n } from '@/i18n'
import type { Reading } from '@/domain/vehicle'
import { clampPercent } from '../format'

/** How a value is shown; anything but `value` is muted so it never reads like data. */
export type ValueState = Reading<unknown>['kind'] | 'unsupported'

/** A sub-panel of the vehicle data card, with its own accessible region. */
export function Panel({
  title,
  className = '',
  children,
}: {
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`vehicle-panel ${className}`.trim()} aria-label={title}>
      <h3 className="vehicle-panel-title">{title}</h3>
      {children}
    </section>
  )
}

/** One labelled value. `calculated` marks values derived by RoadPilot, `hint` explains one. */
export function ValueRow({
  icon,
  label,
  value,
  state = 'value',
  calculated = false,
  hint,
}: {
  icon: ReactNode
  label: string
  value: string
  state?: ValueState
  calculated?: boolean
  hint?: string
}) {
  const { t } = useI18n()
  const title =
    hint ??
    (state === 'invalid'
      ? t('reading.invalidHint')
      : state === 'unsupported'
        ? t('reading.unsupportedHint')
        : calculated
          ? t('common.calculated')
          : undefined)
  return (
    <li className="row">
      <span className="row-icon" aria-hidden>
        {icon}
      </span>
      <span className="row-label">{label}</span>
      <span className={`row-value value-${state}`} title={title}>
        {value}
        {calculated && state === 'value' ? (
          <span className="calc-mark" aria-label={t('common.calculated')}>
            *
          </span>
        ) : null}
      </span>
    </li>
  )
}

/** A horizontal level indicator (fuel, engine speed). Rendered only for a known value. */
export function Meter({
  label,
  value,
  max,
  text,
  warn = false,
}: {
  label: string
  value: number
  max: number
  text: string
  warn?: boolean
}) {
  const percent = max > 0 ? clampPercent((value / max) * 100) : 0
  return (
    <div
      className={`meter${warn ? ' meter-warn' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      aria-valuetext={text}
    >
      <div className="meter-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}
