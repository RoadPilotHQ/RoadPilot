import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createControlSource } from '@/backend/controlSource'
import type { CommandReply, ControlStatus, LogEntry } from '@/domain/control'
import { App } from '@/app/App'
import { controlStatus, fakeControlBridge } from '@/test/controlFixtures'

function setup() {
  const fake = fakeControlBridge()
  const controlSource = createControlSource(fake.bridge)
  render(<App controlSource={controlSource} />)
  return fake
}

const section = () => within(screen.getByRole('region', { name: 'Control' }))
const button = (name: string) => section().getByRole('button', { name })
const disarm = () => button('Disarm')

const active = (overrides: Partial<ControlStatus> = {}) =>
  controlStatus({
    state: 'active',
    permitsOutput: true,
    lastTick: {
      sequence: 300,
      atMs: 9_990,
      verdict: 'onTime',
      latenessMs: 0.2,
      gapMs: 40,
      missed: 0,
      outcome: { code: 'commandEncoded' },
    },
    ...overrides,
  })

const fault = () =>
  controlStatus({
    state: 'fault',
    telemetry: {
      feedConnected: true,
      freshness: 'stale',
      invalidReason: null,
      frameAgeMs: 2_100,
      epoch: 3,
      game: null,
      speedMps: null,
    },
    lastSafetyEvent: { code: 'staleTelemetry', ageMs: 152, atMs: 8_000 },
    lastTick: {
      sequence: 310,
      atMs: 9_990,
      verdict: 'onTime',
      latenessMs: 0.1,
      gapMs: 40,
      missed: 0,
      outcome: { code: 'idle' },
    },
  })

describe('control section', () => {
  it('without a backend: disarm is still available, other commands are not', () => {
    render(<App />)
    expect(
      section().getByText('Control is not running here. Nothing is encoded or sent.'),
    ).toBeInTheDocument()
    expect(disarm()).toBeEnabled()
    for (const name of ['Arm', 'Activate', 'Reset Fault']) expect(button(name)).toBeDisabled()
    expect(section().getByText('Dry Run')).toBeInTheDocument()
  })

  it('shows state, mode, connection, freshness, epoch, tick and watchdog', async () => {
    const fake = setup()
    await fake.push(controlStatus())
    const s = section()
    expect(s.getByLabelText('Supervisor state')).toHaveTextContent('Disabled')
    expect(s.getByText('Dry Run')).toBeInTheDocument()
    expect(s.getByText('ETS2 connected')).toBeInTheDocument()
    expect(s.getByText('Fresh · 12 ms old')).toBeInTheDocument()
    const epochRow = s.getByText('Vehicle epoch').closest('li')!
    expect(epochRow).toHaveTextContent('1')
    expect(s.getByText('#250 · On time · 0.4 ms late')).toBeInTheDocument()
    expect(s.getByText('OK · loop updated 12 ms ago')).toBeInTheDocument()
    expect(s.getByText('Nothing (not active)')).toBeInTheDocument()
    expect(s.getByText(/Nothing is transmitted to the game/)).toBeInTheDocument()
  })

  it('enables only the commands that fit the state; the backend still decides', async () => {
    const fake = setup()
    await fake.push(controlStatus({ state: 'disabled' }))
    expect(button('Arm')).toBeEnabled()
    expect(button('Activate')).toBeDisabled()
    expect(button('Reset Fault')).toBeDisabled()
    await fake.push(controlStatus({ state: 'armed' }))
    expect(button('Arm')).toBeDisabled()
    expect(button('Activate')).toBeEnabled()
    await fake.push(fault())
    expect(button('Reset Fault')).toBeEnabled()
    expect(button('Arm')).toBeDisabled()
    expect(button('Activate')).toBeDisabled()
  })

  it('sends arm and shows the supervisor answer, including a refusal', async () => {
    const fake = setup()
    await fake.push(controlStatus())
    fake.answerWith((command) =>
      Promise.resolve<CommandReply>({
        command,
        outcome: 'rejected',
        rejection: { code: 'notReady', freshness: 'settling' },
        state: 'disabled',
      }),
    )
    await act(async () => {
      fireEvent.click(button('Arm'))
    })
    expect(fake.sent).toEqual(['arm'])
    expect(section().getByText('Arm: rejected – telemetry not ready')).toBeInTheDocument()
  })

  it('disarms with a single click, without a confirmation dialog', async () => {
    const fake = setup()
    await fake.push(active())
    await act(async () => {
      fireEvent.click(disarm())
    })
    expect(fake.sent).toEqual(['disarm'])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(section().getByText('Disarm: accepted')).toBeInTheDocument()
  })

  it('keeps disarm usable during a fault and while another request is pending', async () => {
    const fake = setup()
    await fake.push(fault())
    expect(section().getByLabelText('Supervisor state')).toHaveTextContent('Fault')
    expect(disarm()).toBeEnabled()
    fake.answerWith((command) =>
      command === 'resetFault'
        ? new Promise(() => {})
        : Promise.resolve<CommandReply>({
            command,
            outcome: 'accepted',
            rejection: null,
            state: 'fault',
          }),
    )
    await act(async () => {
      fireEvent.click(button('Reset Fault'))
    })
    expect(disarm()).toBeEnabled()
    await act(async () => {
      fireEvent.click(disarm())
    })
    expect(fake.sent).toEqual(['resetFault', 'disarm'])
  })

  it('keeps the same disarm button and its focus through status updates', async () => {
    const fake = setup()
    await fake.push(active())
    const before = disarm()
    before.focus()
    for (let i = 0; i < 50; i += 1) {
      await fake.push(active({ nowMs: 10_000 + i * 200 }))
    }
    await fake.push(fault())
    await fake.push(controlStatus({ runtime: 'stopped' }))
    expect(disarm()).toBe(before)
    expect(document.activeElement).toBe(before)
    expect(before).toBeEnabled()
  })

  it('distinguishes generated, encoded and not transmitted, and never claims delivery', async () => {
    const fake = setup()
    await fake.push(active())
    const s = section()
    expect(s.getByText('Command')).toBeInTheDocument()
    expect(s.getByText('Generated')).toBeInTheDocument()
    expect(s.getByText('Encoded')).toBeInTheDocument()
    expect(s.getByText('Not transmitted (Dry Run)')).toBeInTheDocument()
    const text = screen.getByRole('region', { name: 'Control' }).textContent ?? ''
    expect(text).not.toMatch(/deliver|sent to the game/i)
    // Every mention of transmission is negated.
    const mentions = text.match(/\w*\s*\w+\s+transmitted/gi) ?? []
    expect(mentions.length).toBeGreaterThanOrEqual(2)
    for (const mention of mentions) {
      expect(mention).toMatch(/not transmitted|nothing is transmitted/i)
    }
  })

  it('shows a disarm message as encoded but not generated', async () => {
    const fake = setup()
    await fake.push(
      controlStatus({
        lastTick: {
          sequence: 9,
          atMs: 9_990,
          verdict: 'onTime',
          latenessMs: 0,
          gapMs: 40,
          missed: 0,
          outcome: { code: 'disarmEncoded' },
        },
      }),
    )
    const s = section()
    expect(s.getByText('Disarm message')).toBeInTheDocument()
    expect(s.getByText('Not generated')).toBeInTheDocument()
    expect(s.getByText('Encoded')).toBeInTheDocument()
    expect(s.getByText('Not transmitted (Dry Run)')).toBeInTheDocument()
  })

  it('shows why output was withheld', async () => {
    const fake = setup()
    await fake.push(
      active({
        lastTick: {
          sequence: 301,
          atMs: 9_990,
          verdict: 'onTime',
          latenessMs: 0,
          gapMs: 40,
          missed: 0,
          outcome: { code: 'withheld', reason: { code: 'nonFiniteRequest', field: 'steering' } },
        },
      }),
    )
    expect(section().getByText('Withheld: invalid controller value')).toBeInTheDocument()
    expect(section().queryByText('Not transmitted (Dry Run)')).not.toBeInTheDocument()
  })

  it('shows the last safety event, the fault freshness and recent decisions', async () => {
    const fake = setup()
    const decisions: LogEntry[] = [
      {
        n: 42,
        atMs: 8_000,
        category: 'decision',
        event: 'transition',
        from: 'active',
        to: 'fault',
        reason: { code: 'safety', event: { code: 'staleTelemetry', ageMs: 152 } },
      },
      { n: 40, atMs: 7_900, category: 'decision', event: 'feedLost' },
      {
        n: 30,
        atMs: 5_000,
        category: 'decision',
        event: 'commandRejected',
        command: 'arm',
        rejection: { code: 'faultNotReset' },
      },
    ]
    await fake.push({ ...fault(), recentDecisions: decisions })
    const s = section()
    expect(s.getByText('Telemetry stale · 2.0 s ago')).toBeInTheDocument()
    expect(s.getByText('Stale · 2100 ms old')).toBeInTheDocument()
    expect(s.getByText('No vehicle data')).toBeInTheDocument()
    const list = within(s.getByRole('list', { name: 'Recent decisions' }))
    expect(list.getByText('Active → Fault: Telemetry stale')).toBeInTheDocument()
    expect(list.getByText('Telemetry channel lost')).toBeInTheDocument()
    expect(list.getByText('Arm rejected: reset the fault first')).toBeInTheDocument()
  })

  it('shows a tripped watchdog and a silent loop', async () => {
    const fake = setup()
    await fake.push(
      controlStatus({
        watchdog: {
          tripPending: false,
          trips: 2,
          lastTripAtMs: 9_000,
          lastSilentMs: 140,
          loopSilentMs: 250,
          timeoutMs: 100,
        },
      }),
    )
    expect(section().getByText('Loop silent for 250 ms · 2 trips so far')).toBeInTheDocument()
    await fake.push(
      controlStatus({
        watchdog: {
          tripPending: true,
          trips: 2,
          lastTripAtMs: 9_000,
          lastSilentMs: 140,
          loopSilentMs: 250,
          timeoutMs: 100,
        },
      }),
    )
    expect(section().getByText('Tripped · 2 trips so far')).toBeInTheDocument()
  })

  it('shows the measured tick interval percentiles and violations', async () => {
    const fake = setup()
    await fake.push(controlStatus())
    expect(
      section().getByText('p99 40.5 · p99.9 40.6 · max 40.7 ms · over 50 ms: 0'),
    ).toBeInTheDocument()
    const status = controlStatus()
    await fake.push({
      ...status,
      nowMs: 20_000,
      timing: {
        ...status.timing,
        intervals: { ...status.timing.intervals, maxMs: 72.6, over50: 1 },
      },
    })
    expect(
      section().getByText('p99 40.5 · p99.9 40.6 · max 72.6 ms · over 50 ms: 1'),
    ).toBeInTheDocument()
    await fake.push({
      ...status,
      nowMs: 30_000,
      timing: { ...status.timing, intervals: { ...status.timing.intervals, count: 0 } },
    })
    expect(section().getByText('No interval yet')).toBeInTheDocument()
  })

  it('says when the control task has stopped', async () => {
    const fake = setup()
    await fake.push(controlStatus({ runtime: 'stopped' }))
    expect(
      section().getByText('The control task has stopped. Nothing is encoded or sent.'),
    ).toBeInTheDocument()
    expect(button('Arm')).toBeDisabled()
    expect(disarm()).toBeEnabled()
  })

  it('does not replace the existing dashboard cards', async () => {
    const fake = setup()
    await fake.push(controlStatus())
    for (const title of [
      'Vehicle Data',
      'Autopilot Settings',
      'Assistance Systems',
      'Route Progress',
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument()
    }
    // The connection badge is still the only status role on the page.
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })
})
