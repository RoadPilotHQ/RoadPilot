import { describe, expect, it } from 'vitest'
import type { ControlStatus } from '@/domain/control'
import { accepted, controlStatus } from '@/test/controlFixtures'
import {
  CONTROL_COMMANDS,
  createControlSource,
  unavailableControlSource,
  type ControlBridge,
} from './controlSource'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function bridgeWith(overrides: Partial<ControlBridge> = {}) {
  let handler: ((s: ControlStatus) => void) | null = null
  const bridge: ControlBridge = {
    listen: async (h) => {
      handler = h
      return () => {
        handler = null
      }
    },
    getStatus: () => new Promise(() => {}),
    send: async (command) => accepted(command, 'armed'),
    ...overrides,
  }
  return { bridge, emit: (s: ControlStatus) => handler?.(s), active: () => handler !== null }
}

describe('control source', () => {
  it('uses the command names registered by the Rust backend', () => {
    expect(Object.values(CONTROL_COMMANDS).sort()).toEqual(
      [
        'control_activate',
        'control_arm',
        'control_disarm',
        'control_log',
        'control_reset_fault',
        'control_status',
      ].sort(),
    )
  })

  it('has no status until the backend reports one, then follows the events', async () => {
    const { bridge, emit } = bridgeWith()
    const source = createControlSource(bridge)
    expect(source.getSnapshot().status).toBeNull()
    await flush()
    emit(controlStatus({ nowMs: 100, state: 'armed' }))
    expect(source.getSnapshot().status?.state).toBe('armed')
  })

  it('ignores an initial snapshot that is older than an event already shown', async () => {
    let resolveInitial: (s: ControlStatus) => void = () => {}
    const { bridge, emit } = bridgeWith({
      getStatus: () => new Promise((resolve) => (resolveInitial = resolve)),
    })
    const source = createControlSource(bridge)
    await flush()
    emit(controlStatus({ nowMs: 500, state: 'fault' }))
    resolveInitial(controlStatus({ nowMs: 100, state: 'disabled' }))
    await flush()
    expect(source.getSnapshot().status?.state).toBe('fault')
  })

  it('tracks a pending request and stores the answer', async () => {
    let finish: () => void = () => {}
    const { bridge } = bridgeWith({
      send: (command) =>
        new Promise((resolve) => (finish = () => resolve(accepted(command, 'armed')))),
    })
    const source = createControlSource(bridge)
    const done = source.request('arm')
    expect(source.getSnapshot().pending).toBe('arm')
    finish()
    const reply = await done
    expect(reply.outcome).toBe('accepted')
    expect(source.getSnapshot().pending).toBeNull()
    expect(source.getSnapshot().lastReply).toEqual(reply)
  })

  it('sends a disarm even while another request is still pending', async () => {
    const sent: string[] = []
    const { bridge } = bridgeWith({
      send: (command) => {
        sent.push(command)
        return command === 'arm'
          ? new Promise(() => {})
          : Promise.resolve(accepted(command, 'disabled'))
      },
    })
    const source = createControlSource(bridge)
    void source.request('arm')
    const reply = await source.request('disarm')
    expect(sent).toEqual(['arm', 'disarm'])
    expect(reply.outcome).toBe('accepted')
  })

  it('turns a failed call into an unavailable answer instead of throwing', async () => {
    const { bridge } = bridgeWith({ send: () => Promise.reject(new Error('ipc down')) })
    const source = createControlSource(bridge)
    const reply = await source.request('disarm')
    expect(reply).toEqual({
      command: 'disarm',
      outcome: 'unavailable',
      rejection: null,
      state: null,
    })
  })

  it('stops listening when disposed', async () => {
    const { bridge, emit, active } = bridgeWith()
    const source = createControlSource(bridge)
    await flush()
    expect(active()).toBe(true)
    source.dispose()
    emit(controlStatus({ state: 'active' }))
    expect(source.getSnapshot().status).toBeNull()
    expect(active()).toBe(false)
  })

  it('outside the desktop app every request is unavailable', async () => {
    expect(unavailableControlSource.getSnapshot().status).toBeNull()
    expect((await unavailableControlSource.request('arm')).outcome).toBe('unavailable')
  })
})
