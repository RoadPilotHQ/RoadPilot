import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMapSource } from '@/backend/mapSource'
import type { MapStatus } from '@/domain/map'
import { PREFERENCES_KEY } from '@/state/preferences'
import { fakeMapBridge } from '@/test/fakeMap'
import { region, renderLiveApp } from '@/test/liveApp'
import { fullData } from '@/test/telemetryFixtures'
import { encodeTile, GOLDEN_REQUEST } from '@/test/tileFixtures'

const nav = () => region('Navigation')
const CONTENT = '5e17e7105e17e710'

const READY: Partial<MapStatus> = {
  state: 'ready',
  game: 'ets2',
  packageGame: 'ets2',
  contentId: CONTENT,
  schema: '1.0',
  counts: { nodes: 10, roads: 4, junctions: 0 },
  bounds: [0, 0, 4096, 4096],
  loadMs: 120,
  tileSizes: [1024, 4096, 16384, 65536],
}

let width = 800
beforeEach(() => {
  width = 800
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width, height: 400, top: 0, left: 0, right: width, bottom: 400 }) as DOMRect,
  )
  localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ mapGame: 'ets2', mapPackages: { ets2: 'D:/maps/ets2', ats: 'D:/maps/ats' } }),
  )
})
afterEach(() => vi.restoreAllMocks())

/** A desktop map backend with a synthetic map: one road through the middle of every tile. */
function setup({ emptyTiles = false } = {}) {
  const fake = fakeMapBridge()
  const requests: { contentId: string; level: number; x: number; z: number }[] = []
  fake.bridge.tile = async (_game, contentId, level, x, z) => {
    requests.push({ contentId, level, x, z })
    const size = [1024, 4096, 16384, 65536][level]!
    const roads = emptyTiles
      ? []
      : [
          {
            index: x * 1000 + z,
            roadClass: 'motorway' as const,
            points: [
              [x * size + 1, z * size + size / 2],
              [x * size + size - 1, z * size + size / 2],
            ] as [number, number][],
          },
        ]
    return encodeTile({ ...GOLDEN_REQUEST, contentId, level, x, z, tileSize: size }, roads)
  }
  const source = createMapSource(fake.bridge)
  const app = renderLiveApp({ mapSource: source })
  return { fake, requests, ...app }
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const radio = (name: string) => nav().getByRole('radio', { name })

describe('road map view', () => {
  it('shows the road map view by default in the desktop app, honestly empty without a package', async () => {
    localStorage.removeItem(PREFERENCES_KEY)
    setup()
    await flush()
    expect(radio('Road map')).toHaveAttribute('aria-checked', 'true')
    expect(
      nav().getByText('No map package selected', { selector: '.navigation-empty-status' }),
    ).toBeVisible()
    expect(nav().getByText('Choose a map package below, or show the traveled path.')).toBeVisible()
  })

  it('shows loading, error and mismatch states in the map area', async () => {
    const { fake } = setup()
    await flush()
    act(() => fake.emit({ state: 'loading', game: 'ets2', phase: 'reading' }))
    expect(
      nav().getByText('Loading and verifying the package…', {
        selector: '.navigation-empty-status',
      }),
    )
    act(() =>
      fake.emit({
        state: 'error',
        game: 'ets2',
        error: { code: 'corrupt_geometry', detail: 'no footer' },
      }),
    )
    expect(nav().getByText(/cannot be used: no footer/, { selector: '.navigation-empty-status' }))
    act(() => fake.emit({ state: 'game_mismatch', game: 'ets2', packageGame: 'ats' }))
    expect(nav().getByText(/for ats, not for ETS2/, { selector: '.navigation-empty-status' }))
  })

  it('draws the roads of the visible tiles of the loaded package only', async () => {
    const { fake, requests } = setup()
    await flush()
    act(() => fake.emit(READY))
    await waitFor(() =>
      expect(nav().getByRole('img', { name: /^Road map of ETS2, [1-9]\d* roads in view$/ })),
    )
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.contentId === CONTENT)).toBe(true)
    // Never outside the map's bounds.
    expect(requests.every((r) => r.x >= 0 && r.z >= 0)).toBe(true)
    expect(nav().getByText(/^\d[\d,]* map units$/)).toBeInTheDocument()
    expect(nav().getByText('Road map · estimated geometry')).toBeInTheDocument()
  })

  it('never puts the truck or its path on the map', async () => {
    const { fake, send } = setup()
    await flush()
    act(() => fake.emit(READY))
    const d = fullData()
    d.position = { x: 2000, y: 0, z: 2000, headingDeg: 0, pitchDeg: 0, rollDeg: 0 }
    await send({ status: 'connected', game: 'ets2', data: d })
    expect(nav().queryByText('Start of trace')).not.toBeInTheDocument()
    expect(nav().queryByText('Last position and heading')).not.toBeInTheDocument()
    expect(nav().getByText(/The truck and its path are not shown on this map/)).toBeInTheDocument()
    expect(nav().getAllByRole('img')).toHaveLength(1)
    // The traveled path is still there, in its own view.
    fireEvent.click(radio('Traveled path'))
    expect(nav().getByText('Start of trace')).toBeInTheDocument()
    expect(nav().getByText('1 points')).toBeInTheDocument()
  })

  it('zooms with the buttons and leaves the whole-map mode', async () => {
    const { fake } = setup()
    await flush()
    act(() => fake.emit(READY))
    expect(radio('Whole map')).toHaveAttribute('aria-checked', 'true')
    const before = nav().getByText(/map units$/).textContent
    fireEvent.click(nav().getByRole('button', { name: 'Zoom in' }))
    expect(nav().getByText(/map units$/).textContent).not.toBe(before)
    expect(radio('Whole map')).toHaveAttribute('aria-checked', 'false')
    expect(radio('Follow truck')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(radio('Whole map'))
    expect(nav().getByText(/map units$/).textContent).toBe(before)
  })

  it('pans by dragging', async () => {
    const { fake, requests } = setup()
    await flush()
    act(() => fake.emit({ ...READY, bounds: [-100_000, -100_000, 100_000, 100_000] }))
    fireEvent.click(nav().getByRole('button', { name: 'Zoom in' }))
    for (let i = 0; i < 6; i++) fireEvent.click(nav().getByRole('button', { name: 'Zoom in' }))
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    const map = nav().getByRole('img').parentElement!
    const seen = requests.length
    // jsdom's pointer events carry no coordinates; mouse events with pointer names do.
    const pointer = (type: string, clientX: number) =>
      fireEvent(map, new MouseEvent(type, { bubbles: true, clientX, clientY: 200 }))
    // About 3,000 units east: beyond the one-tile margin, so new tiles are needed.
    pointer('pointerdown', 700)
    for (const x of [0, -700, -1400, -2100]) pointer('pointermove', x)
    pointer('pointerup', -2100)
    expect(radio('Whole map')).toHaveAttribute('aria-checked', 'false')
    // The map moved east: new tiles on the east side are requested.
    await waitFor(() => expect(requests.length).toBeGreaterThan(seen))
    const newest = requests.slice(seen)
    const before = requests.slice(0, seen)
    expect(Math.max(...newest.map((r) => r.x))).toBeGreaterThan(Math.max(...before.map((r) => r.x)))
  })

  it('follows the truck by centring on its telemetry position, without a marker', async () => {
    const { fake, send, requests } = setup()
    await flush()
    act(() => fake.emit({ ...READY, bounds: [-100_000, -100_000, 100_000, 100_000] }))
    const d = fullData()
    d.position = { x: 50_000, y: 0, z: -30_000, headingDeg: 0, pitchDeg: 0, rollDeg: 0 }
    await send({ status: 'connected', game: 'ets2', data: d })
    fireEvent.click(radio('Follow truck'))
    await waitFor(() => expect(requests.some((r) => r.level === 0)).toBe(true))
    const level0 = requests.filter((r) => r.level === 0)
    // Tiles around x = 50,000 / 1,024 ≈ 48 and z = -30,000 / 1,024 ≈ -30.
    expect(level0.every((r) => Math.abs(r.x - 48) <= 2 && Math.abs(r.z + 30) <= 2)).toBe(true)
  })

  it('shows the whole map when following without a telemetry position', async () => {
    const { fake } = setup()
    await flush()
    act(() => fake.emit(READY))
    fireEvent.click(radio('Follow truck'))
    expect(nav().getByText('No telemetry position: showing the whole map')).toBeInTheDocument()
  })

  it('says so when the visible part of the map has no roads', async () => {
    const { fake } = setup({ emptyTiles: true })
    await flush()
    act(() => fake.emit(READY))
    await waitFor(() => expect(nav().getByText('No roads in this part of the map.')))
  })

  it('never shows the map of the previous game after a switch', async () => {
    const { fake, send, requests } = setup()
    await flush()
    act(() => fake.emit(READY))
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    await send({ status: 'connected', game: 'ats', data: fullData() })
    await flush()
    // The ETS2 status no longer belongs to the shown game: no ETS2 map is drawn.
    expect(nav().queryByRole('img', { name: /Road map of ETS2/ })).not.toBeInTheDocument()
    expect(fake.selections.at(-1)).toMatchObject({ game: 'ats', path: 'D:/maps/ats' })
    act(() =>
      fake.emit({ ...READY, game: 'ats', packageGame: 'ats', contentId: 'cba63760bde5b3a1' }),
    )
    await waitFor(() => expect(requests.some((r) => r.contentId === 'cba63760bde5b3a1')).toBe(true))
    expect(nav().getByRole('img', { name: /Road map of ATS/ })).toBeInTheDocument()
  })

  it('keeps the number of tile requests bounded in a very large window', async () => {
    width = 7680
    const { fake, requests } = setup()
    await flush()
    act(() => fake.emit({ ...READY, bounds: [-500_000, -500_000, 500_000, 500_000] }))
    await waitFor(() => expect(requests.length).toBeGreaterThan(0))
    expect(requests.length).toBeLessThanOrEqual(128)
  })

  it('keeps the dashboard working when the map fails', async () => {
    const { fake, send } = setup()
    await flush()
    act(() =>
      fake.emit({ state: 'error', game: 'ets2', error: { code: 'unreadable', detail: 'x' } }),
    )
    await send({ status: 'connected', game: 'ets2', data: fullData() })
    expect(screen.getByRole('region', { name: 'Vehicle Data' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Current Job' })).toHaveTextContent('Machinery')
  })
})
