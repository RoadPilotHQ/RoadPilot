import { act, render, screen, within } from '@testing-library/react'
import type { TelemetryUpdate } from '@/domain/telemetry'
import { createTelemetrySource, type TelemetryBridge } from '@/backend/telemetrySource'
import { App } from '@/app/App'
import { update } from './telemetryFixtures'

/** Renders the app with a telemetry source driven by synthetic test updates. */
export function renderLiveApp() {
  let handler: ((u: TelemetryUpdate) => void) | null = null
  const bridge: TelemetryBridge = {
    listen: async (_event, h) => {
      handler = h
      return () => {}
    },
    getSnapshot: () => new Promise(() => {}),
  }
  const view = render(<App source={createTelemetrySource(bridge)} />)
  const send = async (overrides: Partial<TelemetryUpdate>) => {
    await act(async () => {
      await Promise.resolve()
      handler?.(update(overrides))
    })
  }
  return { send, ...view }
}

export const region = (name: string) => within(screen.getByRole('region', { name }))
