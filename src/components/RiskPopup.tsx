import { X, Droplets, Clock, MapPin, AlertTriangle, Server, RefreshCw, Activity } from 'lucide-react'
import { RiskQueryResult } from '../hooks/useFloodQuery'
import styles from './RiskPopup.module.css'

interface Props {
  result: RiskQueryResult | null
  loading: boolean
  error: string | null
  serverOnline: boolean
  onClose: () => void
  onSetAlert?: () => void
  alerted?: boolean
  variant?: 'simple' | 'advanced'
}

const RISK_COLORS: Record<string, string> = {
  none: '#22c55e', low: '#84cc16', moderate: '#eab308',
  high: '#f97316', very_high: '#ef4444', unknown: '#7a9ab5',
}

const RISK_LABELS: Record<string, string> = {
  none: 'No Risk', low: 'Low Risk', moderate: 'Moderate Risk',
  high: 'High Risk', very_high: 'Very High Risk', unknown: 'Outside Study Area',
}

export default function RiskPopup({ result, loading, error, serverOnline, onClose, onSetAlert, alerted, variant = 'simple' }: Props) {
  if (!result && !loading && !error) return null

  const color = result ? (RISK_COLORS[result.risk_level] || '#7a9ab5') : '#7a9ab5'
  const label = result ? (RISK_LABELS[result.risk_level] || 'Unknown') : ''
  const riskPct = result?.risk_pct ?? 0

  return (
    <div className={`${styles.popup} ${styles[variant]}`} style={{ '--risk-color': color } as React.CSSProperties}>
      {/* Header */}
      <div className={styles.header} style={{ borderBottomColor: `${color}30` }}>
        <div className={styles.headerLeft}>
          <MapPin size={13} color={color} />
          <span className={styles.addressText}>
            {result?.address
              ? result.address.split(',').slice(0, 3).join(', ')
              : 'Querying location...'}
          </span>
        </div>
        <button className={styles.closeBtn} onClick={onClose}><X size={14} /></button>
      </div>

      {/* Body */}
      <div className={styles.body}>
        {loading && (
          <div className={styles.loadingState}>
            <RefreshCw size={20} className={styles.spinner} />
            <span>Sampling flood risk data...</span>
          </div>
        )}

        {!loading && error && !result && (
          <div className={styles.errorState}>
            <Server size={16} color="#f97316" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <>
            {/* Server offline warning */}
            {!serverOnline && (
              <div className={styles.offlineBanner}>
                <Server size={11} /> Server offline — showing estimated data
              </div>
            )}

            {/* Risk score */}
            <div className={styles.scoreRow}>
              <div className={styles.scoreLeft}>
                <div className={styles.scoreLabel}>{
                  result.source === 'forecast'        ? "✦ Forecast Peak Risk"
                  : result.source === 'historical'     ? "⏱ Historical Peak Risk (Hurricane Ida)"
                  : (result as any).weather            ? "⚡ Dynamic Live Risk"
                                                       : "📍 Static Flood Vulnerability"
                }</div>
                <div className={styles.scoreValue} style={{ color }}>{label}</div>
                {!result.in_bounds && (
                  <div className={styles.outOfBounds}>
                    <AlertTriangle size={11} /> Outside Hudson County study area
                  </div>
                )}
              </div>
              <div className={styles.scorePct} style={{ color }}>{riskPct}%</div>
            </div>

            {/* Risk bar */}
            <div className={styles.riskBar}>
              <div
                className={styles.riskBarFill}
                style={{ width: `${riskPct}%`, background: color }}
              />
              {/* Threshold markers */}
              <div className={styles.marker} style={{ left: '20%' }} title="Low threshold" />
              <div className={styles.marker} style={{ left: '40%' }} title="Moderate threshold" />
              <div className={styles.marker} style={{ left: '60%' }} title="High threshold" />
              <div className={styles.marker} style={{ left: '80%' }} title="Very high threshold" />
            </div>
            <div className={styles.barLabels}>
              <span>None</span><span>Low</span><span>Mod</span><span>High</span><span>V.High</span>
            </div>

            {/* Depth + timing grid */}
            <div className={styles.grid}>
              <div className={styles.gridCell}>
                <div className={styles.gridLabel}><Droplets size={10} /> Est. Water Depth</div>
                <div className={styles.gridValue} style={{ color }}>{result.depth.cm}</div>
                <div className={styles.gridSub}>{result.depth.label}</div>
              </div>
              <div className={styles.gridCell}>
                <div className={styles.gridLabel}><MapPin size={10} /> Coordinates</div>
                <div className={styles.gridValue} style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  {result.lat.toFixed(5)}
                </div>
                <div className={styles.gridSub}>{result.lng.toFixed(5)}</div>
              </div>
            </div>

            {/* Weather conditions strip — only in dynamic mode */}
            {(result as any).weather && (
              <div className={styles.weatherStrip}>
                <span>🌧 {(result as any).weather.rain_mm ?? 0} mm/hr</span>
                <span>💧 soil {Math.round(((result as any).weather.soil_norm ?? 0) * 100)}%</span>
                <span>📈 rain×{(result as any).weather.rain_factor?.toFixed(2) ?? '0.00'}</span>
              </div>
            )}

            {/* Street-level peak risk — shown for forecast + historical modes */}
            {result.hindcast && (
              <div className={styles.hindcastStrip}>
                <div className={styles.hindcastTitle}>
                  <Activity size={10} />
                  <span>
                    Nearest Street ·{' '}
                    {result.source === 'historical'
                      ? 'Hurricane Ida (hindcast)'
                      : 'Live Forecast'}
                  </span>
                  {result.hindcast.name && (
                    <span className={styles.hindcastStreetName}>{result.hindcast.name}</span>
                  )}
                </div>
                <div className={styles.hindcastGrid}>
                  <div className={styles.hindcastCell}>
                    <span className={styles.hindcastLabel}>Peak Risk</span>
                    <span
                      className={styles.hindcastValue}
                      style={{ color: result.hindcast.max_risk != null
                        ? (result.hindcast.max_risk >= 0.10 ? '#f97316'
                          : result.hindcast.max_risk >= 0.06 ? '#eab308' : '#84cc16')
                        : 'var(--text-secondary)' }}
                    >
                      {result.hindcast.max_risk != null
                        ? `${(result.hindcast.max_risk * 100).toFixed(1)}%`
                        : '—'}
                    </span>
                  </div>
                  <div className={styles.hindcastCell}>
                    <span className={styles.hindcastLabel}><Clock size={9} /> First Alert</span>
                    <span className={styles.hindcastValue} style={{ color: '#38bdf8' }}>
                      {result.hindcast.eta_label ?? (result.hindcast.eta_hour != null ? `Hour ${result.hindcast.eta_hour}` : '—')}
                    </span>
                  </div>
                </div>
                {result.hindcast.dist_m > 200 && (
                  <div className={styles.hindcastNote}>
                    ↖ {Math.round(result.hindcast.dist_m)} m to nearest segment
                  </div>
                )}
              </div>
            )}

            {/* Source tag */}
            <div className={styles.sourceTag}>
              {result.source === 'live_tif'        ? '📍 Static vulnerability TIF'
               : result.source === 'dynamic_live'  ? '⚡ Live weather × static FV'
               : result.source === 'dynamic_tif'   ? '⚡ Live forecast risk TIF'
               : result.source === 'forecast'      ? '✦ Live forecast (max_risk + eta_hour)'
               : result.source === 'historical'    ? '⏱ Hurricane Ida hindcast (max_risk + eta_hour)'
               : result.source === 'mock' && result.risk_level !== undefined
                 ? '🟡 Mock — run pipeline for live data'
                 : '🔴 Estimated (server offline)'}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
