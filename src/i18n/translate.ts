import { en, type TranslationKey } from './en'

export type Bundle = Partial<Record<TranslationKey, string>>
export type Params = Record<string, string | number>

export const DEFAULT_LOCALE = 'en'

/** Additional bundles (e.g. loaded from RoadPilot-Language in the future), keyed by locale. */
const bundles: Record<string, Bundle> = {}

export function registerBundle(locale: string, bundle: Bundle): void {
  bundles[locale] = bundle
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Resolves a key for a locale. Falls back to English, then to the key itself,
 * so missing translations never break the UI.
 */
export function translate(locale: string, key: TranslationKey, params?: Params): string {
  const template = bundles[locale]?.[key] ?? en[key] ?? key
  return interpolate(template, params)
}
