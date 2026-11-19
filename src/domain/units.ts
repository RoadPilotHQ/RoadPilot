/**
 * Display units for vehicle data. The data model always stays in the telemetry units (km/h,
 * km, litres, °C, psi); conversion happens only when a value is shown.
 */
import type { GameId, UnitPreference } from './types'

/** `imperial` means US customary units, as used by American Truck Simulator. */
export type UnitSystem = 'metric' | 'imperial'

/** `auto`: ATS shows US customary units, ETS2 (and an unknown game) metric units. */
export function resolveUnitSystem(preference: UnitPreference, game: GameId | null): UnitSystem {
  if (preference !== 'auto') return preference
  return game === 'ats' ? 'imperial' : 'metric'
}

export type UnitKey =
  | 'unit.kmh'
  | 'unit.mph'
  | 'unit.km'
  | 'unit.mi'
  | 'unit.litre'
  | 'unit.gallon'
  | 'unit.lPer100km'
  | 'unit.mpg'
  | 'unit.celsius'
  | 'unit.fahrenheit'
  | 'unit.bar'
  | 'unit.psi'

export interface Measure {
  value: number
  unit: UnitKey
}

const KM_PER_MILE = 1.609344
const LITRES_PER_US_GALLON = 3.785411784
const BAR_PER_PSI = 0.0689475729
/** l/100 km × mpg (US) = 100 × litres per gallon / km per mile. */
const MPG_TIMES_L_PER_100KM = (100 * LITRES_PER_US_GALLON) / KM_PER_MILE

export function speed(kmh: number, system: UnitSystem): Measure {
  return system === 'imperial'
    ? { value: kmh / KM_PER_MILE, unit: 'unit.mph' }
    : { value: kmh, unit: 'unit.kmh' }
}

export function distance(km: number, system: UnitSystem): Measure {
  return system === 'imperial'
    ? { value: km / KM_PER_MILE, unit: 'unit.mi' }
    : { value: km, unit: 'unit.km' }
}

export function volume(litres: number, system: UnitSystem): Measure {
  return system === 'imperial'
    ? { value: litres / LITRES_PER_US_GALLON, unit: 'unit.gallon' }
    : { value: litres, unit: 'unit.litre' }
}

/**
 * Average consumption. mpg is the inverse of l/100 km, so a consumption of zero or less has
 * no mpg value: `null`.
 */
export function consumption(lPer100km: number, system: UnitSystem): Measure | null {
  if (system === 'metric') return { value: lPer100km, unit: 'unit.lPer100km' }
  return lPer100km > 0 ? { value: MPG_TIMES_L_PER_100KM / lPer100km, unit: 'unit.mpg' } : null
}

export function temperature(celsius: number, system: UnitSystem): Measure {
  return system === 'imperial'
    ? { value: (celsius * 9) / 5 + 32, unit: 'unit.fahrenheit' }
    : { value: celsius, unit: 'unit.celsius' }
}

/** Pressures arrive in psi; metric shows bar. */
export function pressure(psi: number, system: UnitSystem): Measure {
  return system === 'imperial'
    ? { value: psi, unit: 'unit.psi' }
    : { value: psi * BAR_PER_PSI, unit: 'unit.bar' }
}
