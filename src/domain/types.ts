/** Connection to the game (ETS2/ATS telemetry), as reported by the Rust telemetry engine. */
export type ConnectionState =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable' | 'error'

export type GameId = 'ets2' | 'ats'

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

/** `null` means the value is not available from the current data source. */
export interface VehicleData {
  /** Signed; negative while reversing. */
  speedKmh: number | null
  /** Cruise control set speed. */
  targetSpeedKmh: number | null
  engineRpm: number | null
  /** Positive forward, zero neutral, negative reverse. */
  gear: number | null
  cruiseControl: boolean | null
  engineRunning: boolean | null
  fuelL: number | null
  /** Calculated from fuel and tank capacity. */
  fuelPercent: number | null
  /** Approximated by the game, not simulated. */
  waterTemperatureC: number | null
}

/** Driver inputs and longitudinal dynamics. */
export interface DynamicsData {
  /** Forward positive, braking negative. */
  accelerationMs2: number | null
  /** Player inputs, 0..1. */
  throttle: number | null
  brake: number | null
  /** Player steering input, -1..1, positive = left. */
  steering: number | null
  cruiseControl: boolean | null
  cruiseControlKmh: number | null
}

/** Route Advisor values as provided by the game. */
export interface NavigationData {
  distanceKm: number | null
  etaMinutes: number | null
  speedLimitKmh: number | null
  /** `false` when the game reports no speed limit. */
  speedLimitShown: boolean | null
}

export interface EnvironmentData {
  /** In-game clock time `HH:MM`. */
  gameClock: string | null
  /** The SCS telemetry SDK provides no weather or rain information. */
  weather: string | null
  rain: string | null
}

export type JobState = 'active' | 'none' | 'delivered' | 'cancelled' | 'unknown'

export interface DeadlineValue {
  /** Days from the current in-game day. */
  dayOffset: number
  /** In-game time, `HH:MM`. */
  time: string
}

export interface JobData {
  state: JobState
  cargo: string | null
  weightKg: number | null
  income: number | null
  /** ISO 4217 code. */
  currency: string | null
  origin: string | null
  destination: string | null
  deadline: DeadlineValue | null
  remainingKm: number | null
  remainingMinutes: number | null
  /** Calculated and approximate in live mode. */
  progressPercent: number | null
  /** Revenue of a delivered job. */
  revenue: number | null
}

export interface DashboardSnapshot {
  mode: DataMode
  connection: ConnectionState
  game: GameId | null
  /** The game reported its simulation as paused. */
  paused: boolean
  autopilotActive: boolean
  vehicle: VehicleData | null
  job: JobData | null
  dynamics: DynamicsData | null
  navigation: NavigationData | null
  environment: EnvironmentData | null
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
