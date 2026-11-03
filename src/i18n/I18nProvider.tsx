import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { TranslationKey } from './en'
import { DEFAULT_LOCALE, translate, type Params } from './translate'

export interface I18n {
  locale: string
  t: (key: TranslationKey, params?: Params) => string
  formatNumber: (value: number) => string
}

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({
  locale = DEFAULT_LOCALE,
  children,
}: {
  locale?: string
  children: ReactNode
}) {
  const value = useMemo<I18n>(
    () => ({
      locale,
      t: (key, params) => translate(locale, key, params),
      formatNumber: (n) => new Intl.NumberFormat(locale).format(n),
    }),
    [locale],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}
