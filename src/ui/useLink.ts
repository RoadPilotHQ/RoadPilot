import { useDashboard } from '@/state/DashboardProvider'
import { resolveUnitSystem, type UnitSystem } from '@/domain/units'
import { link, type Link } from '@/domain/vehicle'
import { useNow } from './vehicle/useNow'

/** The telemetry link as of now, refreshed twice a second so data ages on screen. */
export function useLink(): Link {
  const { snapshot } = useDashboard()
  return link(snapshot, useNow())
}

/** The display unit system for the current game and the user's choice. */
export function useUnitSystem(): UnitSystem {
  const { snapshot, preferences } = useDashboard()
  return resolveUnitSystem(preferences.units, snapshot.game)
}
