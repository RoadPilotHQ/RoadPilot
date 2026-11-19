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

/**
 * Vehicle values of the current frame. `null` means the value is not available from the
 * current data source; `TelemetryMeta.invalidVehicleFields` says whether it was removed as
 * invalid. Units are part of every name and never change; conversion happens only for display.
 */
export interface VehicleData {
  brand: string | null
  model: string | null
  /** Signed; negative while reversing. */
  speedKmh: number | null
  /** Cruise control set speed. */
  targetSpeedKmh: number | null
  engineRpm: number | null
  /** Engine speed limit from the truck configuration. */
  rpmLimit: number | null
  /** Engine gear: positive forward, zero neutral, negative reverse. */
  gear: number | null
  /** Gear shown on the in-game dashboard. */
  displayedGear: number | null
  forwardGears: number | null
  reverseGears: number | null
  cruiseControl: boolean | null
  engineRunning: boolean | null
  electricOn: boolean | null
  fuelL: number | null
  fuelCapacityL: number | null
  /** Calculated from fuel and tank capacity. */
  fuelPercent: number | null
  /** Game estimate. */
  fuelRangeKm: number | null
  /** Game average. */
  fuelConsumptionLPer100km: number | null
  fuelWarning: boolean | null
  adblueL: number | null
  adblueCapacityL: number | null
  /** Approximated by the game, not simulated. */
  waterTemperatureC: number | null
  oilTemperatureC: number | null
  oilPressurePsi: number | null
  batteryVoltageV: number | null
  odometerKm: number | null
  parkingBrake: boolean | null
  engineBrake: boolean | null
  retarderLevel: number | null
  retarderSteps: number | null
  brakeAirPressurePsi: number | null
  brakeTemperatureC: number | null
}

export type VehicleField = keyof VehicleData

/** Where the current values come from and how old they are. */
export interface TelemetryMeta {
  /** 1 = speed, RPM and gear only. */
  schemaVersion: number
  gameVersion: string | null
  sequence: number
  /** When RoadPilot received the frame (Unix epoch milliseconds). */
  receivedAtUnixMs: number
  /** Vehicle values removed as invalid in this frame. */
  invalidVehicleFields: VehicleField[]
  /** Job values removed as invalid in this frame. */
  invalidJobFields: JobField[]
  /** Route Advisor values removed as invalid in this frame. */
  invalidNavigationFields: NavigationField[]
  /** Wire paths of all values removed as invalid, as reported by the telemetry reader. */
  invalidFields: string[]
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
  /** Route Advisor time estimate; whether it counts game or real time is not confirmed. */
  etaMinutes: number | null
  speedLimitKmh: number | null
  /** `false` when the game reports no speed limit. */
  speedLimitShown: boolean | null
}

export type NavigationField = keyof NavigationData

export interface EnvironmentData {
  /** In-game clock time `HH:MM`. */
  gameClock: string | null
  /** The SCS telemetry SDK provides no weather or rain information. */
  weather: string | null
  rain: string | null
}

/** World position and orientation in the game SDK's coordinate conventions. */
export interface PositionData {
  /** Metres; X east, Y up, Z south. */
  x: number
  y: number
  z: number
  /** Degrees counterclockwise from north. */
  headingDeg: number
  /** Degrees; positive = nose up. */
  pitchDeg: number
  /** Degrees; counterclockwise around the forward axis. */
  rollDeg: number
}

export type JobState = 'active' | 'none' | 'delivered' | 'cancelled' | 'unknown'

export interface DeadlineValue {
  /** Days from the current in-game day. */
  dayOffset: number
  /** In-game time, `HH:MM`. */
  time: string
}

/**
 * The job as reported by the game. Names are localized by the game; RoadPilot has no ids for
 * cities or companies. `null` means not provided; see `TelemetryMeta.invalidJobFields`.
 */
export interface JobData {
  state: JobState
  cargo: string | null
  cargoMassKg: number | null
  /** 0–100. */
  cargoDamagePercent: number | null
  cargoLoaded: boolean | null
  /** Game job market token, e.g. `freight_market`. */
  jobMarket: string | null
  sourceCity: string | null
  sourceCompany: string | null
  destinationCity: string | null
  destinationCompany: string | null
  income: number | null
  /** ISO 4217 code of the game currency: EUR in ETS2, USD in ATS. */
  currency: string | null
  /** Calculated from the absolute deadline and the game clock. */
  deadline: DeadlineValue | null
  /** Calculated, in game minutes; negative when late. */
  timeToDeadlineMin: number | null
  plannedDistanceKm: number | null
  /** Calculated and approximate in live mode. */
  progressPercent: number | null
  /** Revenue of a delivered job. */
  deliveredRevenue: number | null
  /** Penalty of a cancelled job. */
  cancelPenalty: number | null
}

export type JobField = Exclude<keyof JobData, 'state'>

export interface DashboardSnapshot {
  mode: DataMode
  connection: ConnectionState
  game: GameId | null
  /** The game reported its simulation as paused. */
  paused: boolean
  /** Present with live values only. */
  telemetry: TelemetryMeta | null
  /** Receive time of the newest frame of this game session, kept while it is interrupted. */
  lastFrameAtUnixMs: number | null
  /** Technical detail of a telemetry error. */
  error: string | null
  autopilotActive: boolean
  vehicle: VehicleData | null
  job: JobData | null
  dynamics: DynamicsData | null
  navigation: NavigationData | null
  environment: EnvironmentData | null
  position: PositionData | null
  availability: {
    autopilot: Record<AutopilotFeature, Availability>
    assistance: Record<AssistanceSystem, Availability>
  }
}

/** `auto` follows the game: metric for ETS2, US customary for ATS. */
export const UNIT_PREFERENCES = ['auto', 'metric', 'imperial'] as const
export type UnitPreference = (typeof UNIT_PREFERENCES)[number]

/** User choices. Persisted locally; not yet applied by any driving backend. */
export interface Preferences {
  autopilot: Record<AutopilotFeature, boolean>
  assistance: Record<AssistanceSystem, boolean>
  drivingDistance: DrivingDistance
  /** Display units of the vehicle data. */
  units: UnitPreference
  /**
   * Folders of locally generated RoadPilot-Map packages, per game. Chosen by the user; the
   * application never searches for or generates packages.
   */
  mapPackages: Record<GameId, string | null>
  /** The game whose map is shown while no game is connected. */
  mapGame: GameId
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
  units: 'auto',
  mapPackages: { ets2: null, ats: null },
  mapGame: 'ets2',
}
