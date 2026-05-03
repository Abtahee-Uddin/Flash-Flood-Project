import { MapMode, AppView } from '../App'
import { WeatherData } from '../hooks/useWeatherData'
import { Wifi, WifiOff, Droplets, Clock, Layers } from 'lucide-react'
import styles from './Header.module.css'

interface Props {
  mapMode: MapMode
  setMapMode: (m: MapMode) => void
  weather: WeatherData
  appView: AppView
  setAppView: (v: AppView) => void
  scenario: string
  setScenario: (s: string) => void
}

export default function Header({ mapMode, setMapMode, weather, appView, setAppView, scenario, setScenario }: Props) {
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <header className={styles.header}>
      {/* Left: Logo + Title */}
      <div className={styles.left}>
        <div className={styles.logoIcon}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="13" stroke="#38bdf8" strokeWidth="1.5" />
            <path d="M6 18 C8 14 10 16 12 13 C14 10 16 15 18 12 C20 9 22 14 22 18" stroke="#38bdf8" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            <path d="M6 21 C8 17 10 19 12 16 C14 13 16 18 18 15 C20 12 22 17 22 21" stroke="#ef4444" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.7"/>
          </svg>
        </div>
        <div className={styles.titleBlock}>
          <div className={styles.sysLabel}>HUDSON COUNTY</div>
          <div className={styles.sysTitle}>FLASH FLOOD INTELLIGENCE SYSTEM</div>
        </div>
        <div className={styles.divider} />
        <div className={styles.meta}>
          <span className={styles.metaTag}>NJ-005</span>
          <span className={styles.metaTag}>OPERATIONAL</span>
        </div>
      </div>

      {/* Center: Map Mode Toggle + Scenario Selector */}
      <div className={styles.center}>
        <div className={styles.modeToggle}>
          <button
            className={`${styles.modeBtn} ${mapMode === 'static' ? styles.active : ''}`}
            onClick={() => setMapMode('static')}
          >
            <span className={styles.modeDot} style={{ background: '#38bdf8' }} />
            STATIC VULNERABILITY
          </button>
          <button
            className={`${styles.modeBtn} ${mapMode === 'dynamic' ? styles.active : ''}`}
            onClick={() => setMapMode('dynamic')}
          >
            <span className={styles.modeDot} style={{ background: '#ef4444' }} />
            DYNAMIC RISK
            {weather.currentRainfall > 0 && (
              <span className={styles.liveTag}>LIVE</span>
            )}
          </button>
          <button
            className={`${styles.modeBtn} ${mapMode === 'forecast' ? styles.active : ''}`}
            onClick={() => setMapMode('forecast')}
          >
            <span className={styles.modeDot} style={{ background: '#a855f7' }} />
            FORECAST
          </button>
          <button
            className={`${styles.modeBtn} ${mapMode === 'historical' ? styles.active : ''}`}
            onClick={() => setMapMode('historical')}
          >
            <span className={styles.modeDot} style={{ background: '#c4b5fd' }} />
            HISTORICAL
          </button>
        </div>

        {/* Rainfall scenario selector — static mode only */}
        {mapMode === 'static' && (
          <div className={styles.scenarioGroup}>
            {(['none','light','heavy','extreme'] as const).map(s => {
              const labels = { none:'No Rain', light:'Light', heavy:'Heavy', extreme:'Extreme' }
              const colors = { none:'#22c55e', light:'#84cc16', heavy:'#f97316', extreme:'#ef4444' }
              return (
                <button
                  key={s}
                  className={`${styles.scenarioBtn} ${scenario === s ? styles.scenarioBtnActive : ''}`}
                  style={{ '--sc': colors[s] } as React.CSSProperties}
                  onClick={() => setScenario(s)}
                >
                  <div className={styles.scenarioDot} style={{ background: colors[s] }} />
                  <span>{labels[s]}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Right: View toggle + Weather + Clock */}
      <div className={styles.right}>
        {/* Simple / Advanced toggle */}
        <div className={styles.viewToggle}>
          <Layers size={12} color="var(--text-muted)" />
          <button
            className={`${styles.viewBtn} ${appView === 'simple' ? styles.viewActive : ''}`}
            onClick={() => setAppView('simple')}
          >
            SIMPLE
          </button>
          <div className={styles.viewDivider} />
          <button
            className={`${styles.viewBtn} ${appView === 'advanced' ? styles.viewActive : ''}`}
            onClick={() => setAppView('advanced')}
          >
            ADVANCED
          </button>
        </div>

        <div className={styles.divider} />

        <div className={styles.weatherChip}>
          <Droplets size={13} color="#38bdf8" />
          <span className={styles.weatherValue}>{weather.currentRainfall.toFixed(1)}</span>
          <span className={styles.weatherUnit}>mm/hr</span>
        </div>
        <div className={styles.connStatus}>
          {weather.error ? (
            <><WifiOff size={13} color="#f97316" /> <span style={{color:'#f97316'}}>SIM</span></>
          ) : (
            <><Wifi size={13} color="#22c55e" /> <span style={{color:'#22c55e'}}>LIVE</span></>
          )}
        </div>
        <div className={styles.clock}>
          <Clock size={12} color="var(--text-muted)" />
          <div>
            <div className={styles.timeValue}>{timeStr}</div>
            <div className={styles.dateValue}>{dateStr}</div>
          </div>
        </div>
        {weather.loading && <div className={styles.spinner} />}
      </div>
    </header>
  )
}
