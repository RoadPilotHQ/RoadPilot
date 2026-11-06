import {
  Activity,
  CircleGauge,
  Clock,
  CloudRain,
  CloudSun,
  Footprints,
  Gauge,
  MapPin,
  Navigation,
  OctagonMinus,
  Timer,
} from 'lucide-react'
import { useDashboard } from '@/state/DashboardProvider'
import { useI18n } from '@/i18n'
import { SteeringWheel } from '../components/SteeringWheel'
import { Card } from '../components/controls'
import { formatDuration } from '../format'
import { Row, useValueText } from './rows'

const percent = (fraction: number) => Math.round(Math.abs(fraction) * 100)

export function DynamicsCard() {
  const { t, formatNumber } = useI18n()
  const { dynamics } = useDashboard().snapshot
  const show = useValueText(dynamics !== null)
  const pct = (v: number) => t('dynamics.percent', { value: formatNumber(percent(v)) })
  const steering = (v: number) =>
    percent(v) === 0
      ? t('dynamics.steering.center')
      : t(v > 0 ? 'dynamics.steering.left' : 'dynamics.steering.right', {
          value: formatNumber(percent(v)),
        })

  return (
    <Card title={t('dynamics.title')}>
      <ul className="rows">
        <Row
          icon={<Activity size={18} />}
          label={t('dynamics.acceleration')}
          value={show(dynamics?.accelerationMs2, (v) =>
            t('dynamics.acceleration.value', {
              value: formatNumber(Math.round(v * 10) / 10),
            }),
          )}
        />
        <Row
          icon={<Footprints size={18} />}
          label={t('dynamics.throttle')}
          value={show(dynamics?.throttle, pct)}
        />
        <Row
          icon={<OctagonMinus size={18} />}
          label={t('dynamics.brake')}
          value={show(dynamics?.brake, pct)}
        />
        <Row
          icon={<SteeringWheel size={18} />}
          label={t('dynamics.steering')}
          value={show(dynamics?.steering, steering)}
        />
        <Row
          icon={<Gauge size={18} />}
          label={t('dynamics.cruise')}
          value={show(dynamics?.cruiseControl, (on) =>
            on && dynamics?.cruiseControlKmh != null
              ? t('dynamics.cruise.set', {
                  value: formatNumber(Math.round(dynamics.cruiseControlKmh)),
                })
              : t(on ? 'vehicle.cruise.on' : 'vehicle.cruise.off'),
          )}
        />
      </ul>
    </Card>
  )
}

export function NavigationCard() {
  const { t, formatNumber } = useI18n()
  const { navigation, mode } = useDashboard().snapshot
  const show = useValueText(navigation !== null)

  return (
    <Card title={t('navigation.title')}>
      <ul className="rows">
        <Row
          icon={<MapPin size={18} />}
          label={t('navigation.distance')}
          value={show(
            navigation?.distanceKm,
            (v) => `${formatNumber(Math.round(v))} ${t('unit.km')}`,
          )}
        />
        <Row
          icon={<Timer size={18} />}
          label={t('navigation.eta')}
          value={show(navigation?.etaMinutes, (v) => t('route.eta', formatDuration(v)))}
        />
        <Row
          icon={<CircleGauge size={18} />}
          label={t('navigation.speedLimit')}
          value={show(navigation?.speedLimitShown, (shown) =>
            shown && navigation?.speedLimitKmh != null
              ? `${formatNumber(navigation.speedLimitKmh)} ${t('unit.kmh')}`
              : t('navigation.speedLimit.none'),
          )}
        />
      </ul>
      {mode === 'live' ? (
        <p className="note">
          <Navigation size={12} aria-hidden /> {t('navigation.source')}
        </p>
      ) : null}
    </Card>
  )
}

export function EnvironmentCard() {
  const { t } = useI18n()
  const { environment } = useDashboard().snapshot
  const show = useValueText(environment !== null)
  // The SCS telemetry SDK has no weather or rain channel.
  const notProvided = environment ? t('environment.notProvided') : t('common.noData')

  return (
    <Card title={t('environment.title')}>
      <ul className="rows">
        <Row
          icon={<Clock size={18} />}
          label={t('environment.gameTime')}
          value={show(environment?.gameClock, (v) => v)}
        />
        <Row
          icon={<CloudSun size={18} />}
          label={t('environment.weather')}
          value={environment?.weather ?? notProvided}
        />
        <Row
          icon={<CloudRain size={18} />}
          label={t('environment.rain')}
          value={environment?.rain ?? notProvided}
        />
      </ul>
    </Card>
  )
}

export function PositionCard() {
  const { t, locale } = useI18n()
  const { position, mode, vehicle } = useDashboard().snapshot
  const show = useValueText(mode === 'live' ? vehicle !== null : false)
  const format = (v: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)
  const metres = (v: number) => t('position.value', { value: format(v) })
  const degrees = (v: number) => t('position.angle', { value: format(v) })

  return (
    <Card title={t('position.title')}>
      <ul className="rows">
        <Row
          icon={<MapPin size={18} />}
          label={t('position.x')}
          value={show(position?.x, metres)}
        />
        <Row
          icon={<MapPin size={18} />}
          label={t('position.y')}
          value={show(position?.y, metres)}
        />
        <Row
          icon={<MapPin size={18} />}
          label={t('position.z')}
          value={show(position?.z, metres)}
        />
        <Row
          icon={<Navigation size={18} />}
          label={t('position.heading')}
          value={show(position?.headingDeg, degrees)}
        />
        <Row
          icon={<Activity size={18} />}
          label={t('position.pitch')}
          value={show(position?.pitchDeg, degrees)}
        />
        <Row
          icon={<Activity size={18} />}
          label={t('position.roll')}
          value={show(position?.rollDeg, degrees)}
        />
      </ul>
      {mode === 'live' ? <p className="note">{t('position.convention')}</p> : null}
    </Card>
  )
}
