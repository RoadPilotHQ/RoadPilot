import type { TelemetryData, TelemetryUpdate } from '@/domain/telemetry'

/** Telemetry data with every value absent, as from a game that provides nothing. */
export function emptyData(): TelemetryData {
  return {
    source: {
      schemaVersion: 2,
      gameVersion: '1.21',
      sequence: 1,
      simulationTimeUs: 1,
      receivedAtUnixMs: 1,
      invalidFields: [],
    },
    vehicle: {
      speedKmh: null,
      engineRpm: null,
      gear: null,
      displayedGear: null,
      engineRunning: null,
      electricOn: null,
      fuelL: null,
      fuelCapacityL: null,
      fuelPercent: null,
      fuelRangeKm: null,
      fuelConsumptionLPer100km: null,
      fuelWarning: null,
      adblueL: null,
      adblueCapacityL: null,
      oilTemperatureC: null,
      waterTemperatureC: null,
      batteryVoltageV: null,
      parkingBrake: null,
      engineBrake: null,
      retarderLevel: null,
      retarderSteps: null,
      cruiseControlOn: null,
      cruiseControlKmh: null,
      brand: null,
      model: null,
    },
    dynamics: {
      longitudinalVelocityMs: null,
      lateralVelocityMs: null,
      verticalVelocityMs: null,
      longitudinalAccelerationMs2: null,
      lateralAccelerationMs2: null,
      verticalAccelerationMs2: null,
      yawRateDegS: null,
      steeringInput: null,
      throttleInput: null,
      brakeInput: null,
      clutchInput: null,
      steeringEffective: null,
      throttleEffective: null,
      brakeEffective: null,
      clutchEffective: null,
      wheelSteeringAngleDeg: null,
    },
    position: null,
    job: {
      state: 'unknown',
      cargo: null,
      cargoMassKg: null,
      cargoDamagePercent: null,
      sourceCity: null,
      sourceCompany: null,
      destinationCity: null,
      destinationCompany: null,
      income: null,
      currency: null,
      deadline: null,
      timeToDeadlineMin: null,
      plannedDistanceKm: null,
      progressPercent: null,
      deliveredRevenue: null,
      cancelPenalty: null,
    },
    navigation: { distanceKm: null, etaMin: null, speedLimitKmh: null, speedLimitShown: null },
    environment: { gameTimeMin: null, gameClock: null, timeScale: null },
  }
}

/** A realistic connected ETS2 frame with an active job. */
export function fullData(): TelemetryData {
  const d = emptyData()
  Object.assign(d.vehicle, {
    speedKmh: 83.4,
    engineRpm: 1350.4,
    gear: 11,
    engineRunning: true,
    fuelL: 412.5,
    fuelCapacityL: 800,
    fuelPercent: 51.6,
    waterTemperatureC: 88,
    cruiseControlOn: true,
    cruiseControlKmh: 80,
  })
  Object.assign(d.dynamics, {
    longitudinalAccelerationMs2: -1.26,
    throttleInput: 0.4,
    brakeInput: 0.25,
    steeringInput: -0.12,
  })
  d.job = {
    ...d.job,
    state: 'active',
    cargo: 'Machinery',
    cargoMassKg: 18000,
    sourceCity: 'Berlin',
    destinationCity: 'Wien',
    income: 31000,
    currency: 'EUR',
    deadline: { dayOffset: 0, time: '18:05' },
    plannedDistanceKm: 680,
    progressPercent: 25,
  }
  d.navigation = { distanceKm: 510, etaMin: 400, speedLimitKmh: 90, speedLimitShown: true }
  d.environment = { gameTimeMin: 2000, gameClock: '09:20', timeScale: 19 }
  return d
}

export function update(overrides: Partial<TelemetryUpdate> = {}): TelemetryUpdate {
  return {
    status: 'disconnected',
    game: null,
    paused: false,
    data: null,
    error: null,
    ...overrides,
  }
}
