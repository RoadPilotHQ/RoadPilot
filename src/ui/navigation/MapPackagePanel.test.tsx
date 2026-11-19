import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createMapSource } from '@/backend/mapSource'
import { PREFERENCES_KEY } from '@/state/preferences'
import { fakeMapBridge, READY_ATS } from '@/test/fakeMap'
import { region, renderLiveApp } from '@/test/liveApp'
import { fullData } from '@/test/telemetryFixtures'

const nav = () => region('Navigation')
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))

function setup() {
  const fake = fakeMapBridge()
  const source = createMapSource(fake.bridge)
  const app = renderLiveApp({ mapSource: source })
  return { fake, source, ...app }
}

describe('map package selection', () => {
  it('says that maps need the desktop app when there is no backend', () => {
    renderLiveApp()
    expect(nav().getByText('Road maps need the RoadPilot desktop app.')).toBeInTheDocument()
  })

  it('starts without a package and never searches for one', async () => {
    const { fake } = setup()
    await flush()
    expect(
      nav().getByText('No map package selected', { selector: '.map-state' }),
    ).toBeInTheDocument()
    // Only the empty selection for the default game: nothing was looked up.
    expect(fake.selections).toEqual([{ game: 'ets2', path: null, reload: false }])
  })

  it('uses the folder the user enters and remembers it per game', async () => {
    const { fake, unmount } = setup()
    await flush()
    fireEvent.change(nav().getByLabelText('ETS2 package folder'), {
      target: { value: '  D:\\Maps\\ets2  ' },
    })
    fireEvent.click(nav().getByRole('button', { name: 'Use folder' }))
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ets2', path: 'D:\\Maps\\ets2', reload: false })
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY)!).mapPackages).toEqual({
      ets2: 'D:\\Maps\\ets2',
      ats: null,
    })

    // The ATS folder is separate.
    fireEvent.click(nav().getByRole('radio', { name: 'ATS' }))
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ats', path: null, reload: false })
    expect(nav().getByLabelText('ATS package folder')).toHaveValue('')

    unmount()
    const again = setup()
    await flush()
    // The last chosen game and its folder are restored after a restart.
    expect(again.fake.selections[0]).toEqual({ game: 'ats', path: null, reload: false })
    fireEvent.click(nav().getByRole('radio', { name: 'ETS2' }))
    await flush()
    expect(again.fake.selections.at(-1)).toEqual({
      game: 'ets2',
      path: 'D:\\Maps\\ets2',
      reload: false,
    })
  })

  it('follows the connected game and loads its own package', async () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ mapPackages: { ets2: 'D:\\Maps\\ets2', ats: 'D:\\Maps\\ats' } }),
    )
    const { fake, send } = setup()
    await flush()
    await send({ status: 'connected', game: 'ats', data: fullData() })
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ats', path: 'D:\\Maps\\ats', reload: false })
    expect(nav().getByText('ATS (connected game)')).toBeInTheDocument()
    expect(nav().queryByRole('radio', { name: 'ETS2' })).not.toBeInTheDocument()

    await send({ status: 'disconnected' })
    await send({ status: 'connected', game: 'ets2', data: fullData() })
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ets2', path: 'D:\\Maps\\ets2', reload: false })
  })

  it('reloads and removes the package', async () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ mapPackages: { ets2: 'D:\\M' } }))
    const { fake } = setup()
    await flush()
    fireEvent.click(nav().getByRole('button', { name: 'Reload' }))
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ets2', path: 'D:\\M', reload: true })
    fireEvent.click(nav().getByRole('button', { name: 'Remove' }))
    await flush()
    expect(fake.selections.at(-1)).toEqual({ game: 'ets2', path: null, reload: false })
  })

  it('shows every map state without directory paths', async () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ mapGame: 'ats', mapPackages: { ats: 'C:\\Users\\someone\\maps' } }),
    )
    const { fake } = setup()
    await flush()
    const cases: [object, RegExp][] = [
      [{ state: 'selecting', game: 'ats' }, /Checking the package/],
      [{ state: 'loading', game: 'ats', phase: 'reading' }, /Loading and verifying/],
      [{ state: 'loading', game: 'ats', phase: 'preparing' }, /Preparing the map/],
      [READY_ATS, /Map ready · 224,870 roads · loaded in 5.3 s/],
      [{ state: 'game_mismatch', game: 'ats', packageGame: 'ets2' }, /for ets2, not for ATS/],
      [{ state: 'unsupported_version', game: 'ats', schema: '2' }, /version 2 is not supported/],
      [
        {
          state: 'error',
          game: 'ats',
          error: { code: 'file_mismatch', detail: 'geometry.jsonl checksum differs' },
        },
        /cannot be used: geometry.jsonl checksum differs/,
      ],
    ]
    for (const [status, text] of cases) {
      act(() => fake.emit(status))
      expect(nav().getByText(text, { selector: '.map-state' })).toBeInTheDocument()
    }
    expect(screen.queryByText(/someone/, { selector: '.map-state' })).not.toBeInTheDocument()
  })

  it('shows the package details once ready', async () => {
    localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({ mapGame: 'ats', mapPackages: { ats: 'D:\\Maps\\ats' } }),
    )
    const { fake } = setup()
    await flush()
    act(() => fake.emit(READY_ATS))
    expect(
      nav().getByText('Content id cba63760bde5b3a1 · schema 1.0 · 224,870 roads · 902,347 nodes'),
    ).toBeInTheDocument()
  })

  it('ignores a status for the other game', async () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ mapGame: 'ets2' }))
    const { fake } = setup()
    await flush()
    act(() => fake.emit(READY_ATS))
    expect(nav().queryByText(/Map ready/)).not.toBeInTheDocument()
  })
})
