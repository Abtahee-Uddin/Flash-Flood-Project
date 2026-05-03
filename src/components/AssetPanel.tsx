import { AssetRisk, getRiskColor, RiskLevel } from '../utils/floodRisk'
import { WeatherData } from '../hooks/useWeatherData'
import { X, MapPin, Clock, Droplets, Activity, Building2, Navigation } from 'lucide-react'
import styles from './AssetPanel.module.css'

interface Props {
  asset: AssetRisk
  onClose: () => void
  weather: WeatherData
}

const RISK_LABELS: Record<RiskLevel, string> = {
  very_high: 'VERY HIGH', high: 'HIGH', moderate: 'MODERATE', low: 'LOW', none: 'NONE'
}

export default function AssetPanel({ asset, onClose, weather }: Props) {
  const color = getRiskColor(asset.riskLevel)
  const dynamicPct = Math.round(asset.dynamicRisk * 100)
  const staticPct = Math.round(asset.staticFV * 100)

  // Model breakdown
  const rainContrib = asset.staticFV * 0.6 * (asset.rainfallMm / 50)
  const soilContrib = asset.staticFV * 0.4 * Math.min(1, Math.max(0, (asset.soilMoisture - 0.1) / 0.5))

  return (
    <div className={styles.panel} style={{ '--asset-color': color } as React.CSSProperties}>
      {/* Header */}
      <div className={styles.header} style={{ borderColor: `${color}40` }}>
        <div className={styles.assetType}>
          {asset.type === 'building' ? <Building2 size={13} /> : <Navigation size={13} />}
          <span>{asset.type.toUpperCase()}</span>
        </div>
        <button className={styles.closeBtn} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className={styles.content}>
        {/* Name + address */}
        <div className={styles.nameBlock}>
          <div className={styles.name}>{asset.name}</div>
          {asset.address && (
            <div className={styles.address}>
              <MapPin size={10} color="var(--text-muted)" />
              <span>{asset.address}</span>
            </div>
          )}
          <div className={styles.coords}>
            <span>LAT {asset.lat.toFixed(4)}</span>
            <span>LNG {asset.lng.toFixed(4)}</span>
          </div>
        </div>

        {/* Risk badge */}
        <div className={styles.riskBadge} style={{ borderColor: `${color}50`, background: `${color}10` }}>
          <div className={styles.riskBadgeLabel} style={{ color }}>
            {RISK_LABELS[asset.riskLevel]}
          </div>
          <div className={styles.riskBadgeScore} style={{ color }}>
            {dynamicPct}%
          </div>
        </div>

        {/* ETA */}
        {asset.etaMinutes !== null ? (
          <div className={styles.etaBlock}>
            <Clock size={12} color="#ef4444" />
            <span className={styles.etaLabel}>CRITICAL RISK ETA:</span>
            <span className={styles.etaValue}>{asset.etaMinutes} MIN</span>
          </div>
        ) : (
          <div className={styles.etaBlock} style={{ opacity: 0.5 }}>
            <Clock size={12} color="var(--text-muted)" />
            <span className={styles.etaLabel}>NO CRITICAL THRESHOLD FORECASTED</span>
          </div>
        )}

        {/* Impact */}
        <div className={styles.impactBlock} style={{ borderColor: `${color}30`, background: `${color}08` }}>
          <div className={styles.impactLabel}>IMPACT ASSESSMENT</div>
          <div className={styles.impactText}>{asset.impactCategory}</div>
        </div>

        {/* Model breakdown */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}><Activity size={11} /> RISK MODEL BREAKDOWN</div>

          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Static Vulnerability (FV)</span>
            <div className={styles.metricBar}>
              <div className={styles.metricBarFill} style={{ width: `${staticPct}%`, background: '#38bdf8' }} />
            </div>
            <span className={styles.metricVal} style={{ color: '#38bdf8' }}>{staticPct}%</span>
          </div>

          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Rain Factor (×0.6)</span>
            <div className={styles.metricBar}>
              <div className={styles.metricBarFill} style={{ width: `${Math.round(rainContrib * 100)}%`, background: '#eab308' }} />
            </div>
            <span className={styles.metricVal} style={{ color: '#eab308' }}>{Math.round(rainContrib * 100)}%</span>
          </div>

          <div className={styles.metricRow}>
            <span className={styles.metricLabel}>Wetness Factor (×0.4)</span>
            <div className={styles.metricBar}>
              <div className={styles.metricBarFill} style={{ width: `${Math.round(soilContrib * 100)}%`, background: '#7c3aed' }} />
            </div>
            <span className={styles.metricVal} style={{ color: '#7c3aed' }}>{Math.round(soilContrib * 100)}%</span>
          </div>

          <div className={styles.formula}>
            FV × (0.6 × Rain + 0.4 × Wetness) = {dynamicPct}%
          </div>
        </div>

        {/* Current conditions */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}><Droplets size={11} /> CURRENT CONDITIONS</div>
          <div className={styles.condGrid}>
            <div className={styles.condCell}>
              <div className={styles.condLabel}>RAINFALL</div>
              <div className={styles.condValue}>{asset.rainfallMm.toFixed(1)} <span>mm/hr</span></div>
            </div>
            <div className={styles.condCell}>
              <div className={styles.condLabel}>SOIL MOISTURE</div>
              <div className={styles.condValue}>{(asset.soilMoisture * 100).toFixed(0)} <span>%</span></div>
            </div>
            <div className={styles.condCell}>
              <div className={styles.condLabel}>RAIN FACTOR</div>
              <div className={styles.condValue}>{(asset.rainfallMm / 50).toFixed(2)}</div>
            </div>
            <div className={styles.condCell}>
              <div className={styles.condLabel}>LAST UPDATE</div>
              <div className={styles.condValue} style={{ fontSize: '10px' }}>
                {weather.lastUpdated?.toLocaleTimeString('en-US', { hour12: false }) || '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Forecast mini-chart */}
        {weather.hourlyForecast.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>12-HOUR RISK FORECAST</div>
            <div className={styles.miniChart}>
              {weather.hourlyForecast.slice(0, 12).map((h, i) => {
                const risk = asset.staticFV * (0.6 * h.rainFactor + 0.4 * h.wetnessFactor)
                const barH = Math.max(3, risk * 48)
                const c = risk > 0.8 ? '#ef4444' : risk > 0.6 ? '#f97316' : risk > 0.4 ? '#eab308' : '#22c55e'
                return (
                  <div key={i} className={styles.miniBar} title={`${h.time.getHours()}:00 — ${Math.round(risk * 100)}%`}>
                    <div className={styles.miniBarFill} style={{ height: `${barH}px`, background: c }} />
                    <div className={styles.miniBarHour}>{h.time.getHours().toString().padStart(2, '0')}</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
