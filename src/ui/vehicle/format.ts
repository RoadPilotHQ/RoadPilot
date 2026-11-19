import { useMemo } from 'react'
import { useI18n, type TranslationKey } from '@/i18n'
import type { Measure } from '@/domain/units'
import type { Reading } from '@/domain/vehicle'

const READING_KEYS: Record<Exclude<Reading<unknown>['kind'], 'value'>, TranslationKey> = {
  missing: 'reading.missing',
  invalid: 'reading.invalid',
  noData: 'reading.noData',
}

/** Text helpers shared by the vehicle panels. */
export function useVehicleFormat() {
  const { t, locale } = useI18n()
  return useMemo(() => {
    const number = (value: number, digits = 0) => {
      // Rounding must not produce "-0".
      const rounded = Number(value.toFixed(digits)) || 0
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(rounded)
    }
    const measure = (m: Measure, digits = 0) => `${number(m.value, digits)} ${t(m.unit)}`
    const reading = <T>(r: Reading<T>, format: (value: T) => string) =>
      r.kind === 'value' ? format(r.value) : t(READING_KEYS[r.kind])
    const gear = (g: number) =>
      g === 0 ? t('vehicle.gear.neutral') : g < 0 ? t('vehicle.gear.reverse', { gear: -g }) : `${g}`
    const age = (ms: number) =>
      ms < 10_000
        ? t('link.age.seconds', { value: number(ms / 1000, 1) })
        : ms < 120_000
          ? t('link.age.seconds', { value: number(ms / 1000) })
          : t('link.age.minutes', { value: number(Math.floor(ms / 60_000)) })
    const clock = (unixMs: number) =>
      new Date(unixMs).toLocaleTimeString(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    return { t, locale, number, measure, reading, gear, age, clock }
  }, [t, locale])
}
