import { describe, expect, it } from 'vitest'
import { en, type TranslationKey } from './en'
import { registerBundle, translate } from './translate'

describe('translate', () => {
  it('returns English text and interpolates params', () => {
    expect(translate('en', 'nav.dashboard')).toBe('Dashboard')
    expect(translate('en', 'job.route', { origin: 'A', destination: 'B' })).toBe('A → B')
  })

  it('uses a registered bundle and falls back to English for missing keys', () => {
    registerBundle('xx', { 'nav.dashboard': 'Übersicht' })
    expect(translate('xx', 'nav.dashboard')).toBe('Übersicht')
    expect(translate('xx', 'nav.logs')).toBe(en['nav.logs'])
  })

  it('falls back to English for unknown locales and to the key for unknown keys', () => {
    expect(translate('zz', 'nav.about')).toBe('About')
    expect(translate('en', 'does.not.exist' as TranslationKey)).toBe('does.not.exist')
  })

  it('keeps unresolved placeholders visible instead of throwing', () => {
    expect(translate('en', 'route.remaining')).toBe('{distance} remaining')
  })
})
