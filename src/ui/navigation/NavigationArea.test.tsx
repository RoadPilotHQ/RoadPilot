import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryData } from '@/domain/telemetry'
import { LOCAL_STALE_AFTER_MS } from '@/domain/vehicle'
import { fullData } from '@/test/telemetryFixtures'
import { region, renderLiveApp } from '@/test/liveApp'
import css from '@/theme/theme.css?raw'

const nav = () => region('Navigation')
/** The scale bar: its accessible label and the drawn bar width. */
const scale = () => {
  const el = nav().getByLabelText(/^Scale/)
  return {
    label: el.getAttribute('aria-label'),
    width: (el.querySelector('.path-scale-bar') as HTMLElement).style.width,
  }
}

function at(x: number, z: number, headingDeg = 0): TelemetryData {
  const d = fullData()
  d.position = { x, y: 0, z, headingDeg, pitchDeg: 0, rollDeg: 0 }
  return d
}

let width = 800
beforeEach(() => {
  width = 800
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400 }) as DOMRect,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('navigation area', () => {
  it('states that it shows a traveled path, not a map', () => {
    renderLiveApp()
    expect(nav().getByText('Traveled path · not a map')).toBeInTheDocument()
    expect(nav().getByText(/No roads, no map, no route and no destination/)).toBeInTheDocument()
  })

  it('shows an honest empty state with demo data', () => {
    renderLiveApp()
    expect(nav().getByText(/No game connected/)).toBeInTheDocument()
    expect(nav().getByText('0 points')).toBeInTheDocument()
    expect(nav().queryByLabelText(/^Scale/)).not.toBeInTheDocument()
  })

  it('shows an empty state when the telemetry has no position', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: { ...fullData(), position: null } })
    expect(nav().getByText('The telemetry provides no position yet.')).toBeInTheDocument()
  })

  it('traces valid positions with a scale', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(100, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(100, 250, 180) })
    expect(nav().getByText('3 points')).toBeInTheDocument()
    expect(nav().queryByText(/No game connected/)).not.toBeInTheDocument()
    expect(nav().getByRole('img', { name: 'Traveled path of the truck, 3 points' })).toBeVisible()
    // Follow mode: 1,500 m over 352 px; a quarter of 800 px is about 850 m -> 500 m.
    expect(nav().getByLabelText('Scale: 500 m')).toBeInTheDocument()
  })

  it('uses feet and miles for the scale in ATS', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ats', data: at(0, 0) })
    expect(nav().getByLabelText(/^Scale: .* (ft|mi)$/)).toBeInTheDocument()
  })

  it('switches between following the truck and the whole path', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(900, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(1800, 0) })
    const follow = nav().getByLabelText(/^Scale/).textContent
    fireEvent.click(nav().getByRole('radio', { name: 'Whole path' }))
    expect(nav().getByLabelText(/^Scale/).textContent).not.toBe(follow)
  })

  it('skips invalid and non-finite coordinates and says so', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(Number.NaN, 5) })
    await send({ status: 'connected', game: 'ets2', data: at(3e7, 5) })
    expect(nav().getByText('1 points')).toBeInTheDocument()
    expect(nav().getByText('2 invalid positions skipped')).toBeInTheDocument()
  })

  it('marks a stale position', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    expect(nav().queryByText(/Position not current/)).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(LOCAL_STALE_AFTER_MS + 600)
    })
    expect(nav().getByText(/^Position not current · last 3\.\d s ago$/)).toBeInTheDocument()
    // The path stays, and a stale frame adds nothing.
    expect(nav().getByText('1 points')).toBeInTheDocument()
  })

  it('clears the path when the game changes', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    await send({ status: 'connected', game: 'ets2', data: at(100, 0) })
    expect(nav().getByText('2 points')).toBeInTheDocument()
    await send({ status: 'disconnected' })
    expect(nav().getByText('2 points')).toBeInTheDocument()
    await send({ status: 'connecting', game: 'ats' })
    expect(nav().getByText('0 points')).toBeInTheDocument()
    await send({ status: 'connected', game: 'ats', data: at(-40_000, 9_000) })
    expect(nav().getByText('1 points')).toBeInTheDocument()
  })

  it('redraws for a new size without ResizeObserver', async () => {
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    const before = scale()
    expect(before.label).toBe('Scale: 500 m')
    width = 300
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    // 252 px for 1,500 m: a quarter of 300 px is about 450 m, so the bar shows 200 m.
    expect(scale().label).toBe('Scale: 200 m')
    expect(scale().width).not.toBe(before.width)
  })

  it('follows its container with ResizeObserver', async () => {
    const observed: (() => void)[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observed.push(cb)
        }
        observe() {}
        disconnect() {}
      },
    )
    const { send } = renderLiveApp()
    await send({ status: 'connected', game: 'ets2', data: at(0, 0) })
    const before = scale()
    width = 1600
    act(() => observed.forEach((cb) => cb()))
    expect(scale().width).not.toBe(before.width)
  })
})

describe('navigation layout', () => {
  it('puts the route information beside the path on wide windows and below on narrow ones', () => {
    expect(css).toMatch(
      /\.navigation-layout \{[^}]*grid-template-columns: minmax\(0, 2\.2fr\) minmax\(280px, 1fr\)/,
    )
    const medium = [...css.matchAll(/@media \(max-width: 1000px\) \{[\s\S]*?\n\}\n/g)].map(
      (m) => m[0],
    )
    expect(
      medium.some((b) =>
        /\.navigation-layout \{\s*grid-template-columns: minmax\(0, 1fr\)/.test(b),
      ),
    ).toBe(true)
    expect(css).toMatch(/\.navigation-stage \{[^}]*min-height: clamp\(/)
    expect(css).toMatch(/\.navigation \{[^}]*min-width: 0/)
  })

  it('renders the navigation area before the vehicle data', () => {
    renderLiveApp()
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(regions.indexOf('Current Job')).toBeLessThan(regions.indexOf('Navigation'))
    expect(regions.indexOf('Navigation')).toBeLessThan(regions.indexOf('Route Information'))
    expect(regions.indexOf('Route Information')).toBeLessThan(regions.indexOf('Vehicle Data'))
  })
})
