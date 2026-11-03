/** Connection to the game (ETS2/ATS telemetry). */
export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Where the displayed values come from. `demo` data must never look like a live session. */
export type DataMode = 'live' | 'demo'

export type DrivingDistance = 'short' | 'medium' | 'long'

export const AUTOPILOT_FEATURES = ['laneKeeping', 'speedControl', 'trafficAwareness'] as const
export type AutopilotFeature = (typeof AUTOPILOT_FEATURES)[number]

export const ASSISTANCE_SYSTEMS = [
  'laneDepartureWarning',
  'collisionWarning',
  'trafficSignRecognition',
  'adaptiveCruiseControl',
  'driverAssistance',
  'autoBraking',
] as const
export type AssistanceSystem = (typeof ASSISTANCE_SYSTEMS)[number]

/** Whether the backend actually implements a feature. */
export type Availability = 'available' | 'unavailable'

export interface VehicleData {
  speedKmh: number
  targetSpeedKmh: number
  engineRpm: number
  gear: number
  cruiseControl: boolean
}

export interface DeadlineValue {
  /** Days from the current in-game day. */
  dayOffset: number
  /** In-game time, `HH:MM`. */
  time: string
}

export interface JobData {
  cargo: string
  weightKg: number
  income: number
  currency: string
  origin: string
  destination: string
  deadline: DeadlineValue | null
  remainingKm: number
  remainingMinutes: number
  progressPercent: number
}

export interface DashboardSnapshot {
  mode: DataMode
  connection: ConnectionState
  autopilotActive: boolean
  vehicle: VehicleData | null
  job: JobData | null
  availability: {
    autopilot: Record<AutopilotFeature, Availability>
    assistance: Record<AssistanceSystem, Availability>
  }
}

/** User choices. Persisted locally; not yet applied by any driving backend. */
export interface Preferences {
  autopilot: Record<AutopilotFeature, boolean>
  assistance: Record<AssistanceSystem, boolean>
  drivingDistance: DrivingDistance
}

export const DEFAULT_PREFERENCES: Preferences = {
  autopilot: { laneKeeping: true, speedControl: true, trafficAwareness: true },
  assistance: {
    laneDepartureWarning: true,
    collisionWarning: true,
    trafficSignRecognition: true,
    adaptiveCruiseControl: true,
    driverAssistance: true,
    autoBraking: true,
  },
  drivingDistance: 'medium',
}
