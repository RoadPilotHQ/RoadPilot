import type { ReactNode } from 'react'
import { useI18n } from '@/i18n'

/** One labelled value in a data card. `calculated` marks values derived by RoadPilot. */
export function Row({
  icon,
  label,
  value,
  calculated = false,
}: {
  icon: ReactNode
  label: string
  value: string
  calculated?: boolean
}) {
  const { t } = useI18n()
  return (
    <li className="row">
      <span className="row-icon" aria-hidden>
        {icon}
      </span>
      <span className="row-label">{label}</span>
      <span className="row-value" title={calculated ? t('common.calculated') : undefined}>
        {value}
        {calculated ? (
          <span className="calc-mark" aria-label={t('common.calculated')}>
            *
          </span>
        ) : null}
      </span>
    </li>
  )
}

/**
 * Formats optional values for a card. Without the whole section: "No data" (nothing is
 * connected). With the section but without this value: "Not available" (the source does not
 * provide it). Never a zero or a placeholder number.
 */
export function useValueText(sectionPresent: boolean) {
  const { t } = useI18n()
  return <T,>(value: T | null | undefined, format: (v: T) => string): string =>
    !sectionPresent ? t('common.noData') : value == null ? t('common.unavailable') : format(value)
}
