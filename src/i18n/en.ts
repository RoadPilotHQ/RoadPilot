/**
 * Bundled English fallback.
 *
 * Canonical translations live in the separate RoadPilot-Language repository (see
 * docs/localization.md). This file only guarantees that the application works completely in
 * English without any external resource. Keys are the contract with the language repository.
 */
export const en = {
  'app.name': 'RoadPilot',

  'nav.dashboard': 'Dashboard',
  'nav.driving': 'Driving',
  'nav.settings': 'Settings',
  'nav.logs': 'Logs',
  'nav.about': 'About',
  'nav.label': 'Main navigation',

  'game.ets2': 'ETS2',
  'game.ats': 'ATS',
  'game.any': 'ETS2/ATS',

  'connection.connected': '{game} Connected',
  'connection.paused': '{game} Paused',
  'connection.disconnected': 'Game not running',
  'connection.connecting': '{game} Connecting…',
  'connection.reconnecting': '{game} Reconnecting…',
  'connection.unavailable': '{game} Telemetry unavailable',
  'connection.error': 'Telemetry error',

  'mode.demo': 'Demo data',
  'mode.demoHint': 'Values are sample data, not a live game session.',
  'mode.hint.connecting': 'Waiting for the first telemetry data from {game}.',
  'mode.hint.unavailable':
    '{game} is running, but no telemetry arrives. Check that the RoadPilot telemetry plugin is installed.',
  'mode.hint.error':
    'The telemetry connection could not be opened. Another telemetry reader may be running.',
  'mode.live': 'Live data',
  'mode.liveHint':
    'Telemetry from {game}. Values the game plugin does not provide are marked as not available.',
  'mode.interrupted': 'Telemetry interrupted',
  'mode.interruptedHint': 'No new data from {game}. Waiting for the connection to resume.',

  'common.unavailable': 'Not available',
  'common.noData': 'No data',
  'common.comingSoon': 'This section is planned for a later development phase.',

  'overview.autopilot': 'Autopilot',
  'overview.autopilot.active': 'Active',
  'overview.autopilot.inactive': 'Inactive',
  'overview.speed': 'Speed',
  'overview.speed.target': 'Target: {value} km/h',
  'overview.job': 'Current Job',
  'overview.remaining': 'Remaining',

  'unit.kmh': 'km/h',
  'unit.km': 'km',
  'unit.rpm': 'rpm',
  'unit.kg': 'kg',

  'vehicle.title': 'Vehicle Data',
  'vehicle.speed': 'Speed',
  'vehicle.rpm': 'Engine RPM',
  'vehicle.gear': 'Gear',
  'vehicle.cruise': 'Cruise Control',
  'vehicle.cruise.on': 'On',
  'vehicle.cruise.off': 'Off',
  'vehicle.gear.neutral': 'N',
  'vehicle.gear.reverse': 'R{gear}',

  'autopilot.title': 'Autopilot Settings',
  'autopilot.laneKeeping': 'Lane Keeping',
  'autopilot.speedControl': 'Speed Control',
  'autopilot.trafficAwareness': 'Traffic Awareness',
  'autopilot.distance': 'Driving Distance',
  'autopilot.distance.short': 'Short',
  'autopilot.distance.medium': 'Medium',
  'autopilot.distance.long': 'Long',
  'autopilot.preferenceNote': 'Saved as a preference. Not yet applied to the game.',

  'assist.title': 'Assistance Systems',
  'assist.laneDepartureWarning': 'Lane Departure Warning',
  'assist.collisionWarning': 'Collision Warning',
  'assist.trafficSignRecognition': 'Traffic Sign Recognition',
  'assist.adaptiveCruiseControl': 'Adaptive Cruise Control',
  'assist.driverAssistance': 'Driver Assistance',
  'assist.autoBraking': 'Auto Braking',
  'assist.unavailable': 'Planned',
  'assist.preferenceNote':
    'Preferences are saved locally. These planned systems do not control the game.',

  'job.title': 'Current Job',
  'job.cargo': 'Cargo',
  'job.weight': 'Weight',
  'job.income': 'Income',
  'job.deadline': 'Deadline',
  'job.route': '{origin} → {destination}',
  'job.none': 'No active job',
  'job.deadline.today': 'Today, {time}',
  'job.deadline.tomorrow': 'Tomorrow, {time}',
  'job.deadline.inDays': 'In {days} days, {time}',

  'route.title': 'Route Progress',
  'route.remaining': '{distance} remaining',
  'route.eta': '≈ {hours} h {minutes} min',
  'route.progress': 'Route progress',

  'page.driving.title': 'Driving',
  'page.settings.title': 'Settings',
  'page.logs.title': 'Logs',
  'page.about.title': 'About',
} as const

export type TranslationKey = keyof typeof en
