import { UseWatchlistReturn } from '../hooks/useWatchlist'
import { WeatherData } from '../hooks/useWeatherData'
import styles from './StatusBar.module.css'

interface Props {
  weather: WeatherData
  watchlist: UseWatchlistReturn
}

export default function StatusBar({ weather, watchlist }: Props) {
  const items = watchlist.items
  const criticalCount = items.filter(i => i.risk_level === 'very_high').length
  const highCount = items.filter(i => i.risk_level === 'high').length
  const alertCount = items.filter(i => i.alertEnabled).length
  const checkedItems = items.filter(i => i.risk_pct !== null)
  const avgRisk = checkedItems.length > 0
    ? checkedItems.reduce((sum, i) => sum + (i.risk_pct ?? 0), 0) / checkedItems.length
    : 0

  const overallStatus = criticalCount > 0 ? 'CRITICAL' : highCount > 0 ? 'ELEVATED' : 'NORMAL'
  const statusColor = overallStatus === 'CRITICAL' ? '#ef4444' : overallStatus === 'ELEVATED' ? '#f97316' : '#22c55e'

  return (
    <div className={styles.statusBar}>
      <div className={styles.left}>
        <div className={styles.statusChip} style={{ color: statusColor, borderColor: `${statusColor}30` }}>
          <div className={styles.statusDot} style={{ background: statusColor }} />
          SYSTEM STATUS: {overallStatus}
        </div>
        {weather.error && <div className={styles.warnChip}>⚠ {weather.error}</div>}
      </div>

      <div className={styles.center}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>WATCHED</span>
          <span className={styles.statValue}>{items.length}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.statLabel}>CRITICAL</span>
          <span className={styles.statValue} style={{ color: '#ef4444' }}>{criticalCount}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.statLabel}>HIGH RISK</span>
          <span className={styles.statValue} style={{ color: '#f97316' }}>{highCount}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.statLabel}>ALERTS</span>
          <span className={styles.statValue} style={{ color: '#38bdf8' }}>{alertCount}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.statLabel}>AVG RISK</span>
          <span className={styles.statValue}>{checkedItems.length > 0 ? `${Math.round(avgRisk)}%` : '—'}</span>
        </div>
        <div className={styles.divider} />
        <div className={styles.stat}>
          <span className={styles.statLabel}>DATA</span>
          <span className={styles.statValue} style={{ color: weather.error ? '#f97316' : '#22c55e' }}>
            {weather.error ? 'SIMULATED' : 'OPEN-METEO'}
          </span>
        </div>
      </div>

      <div className={styles.right}>
        <span className={styles.modelTag}>MODEL: Static FV × (0.6 × Rain + 0.4 × Wetness)</span>
        {weather.lastUpdated && (
          <span className={styles.updateTag}>UPDATED {weather.lastUpdated.toLocaleTimeString('en-US', { hour12: false })}</span>
        )}
      </div>
    </div>
  )
}
