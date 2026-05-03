import { useState, useEffect, useCallback, useRef } from 'react'
import { Sparkles, RefreshCw, CheckCircle, AlertTriangle, Clock, Database, CloudRain, Layers, MapPin } from 'lucide-react'
import styles from './ForecastPanel.module.css'

interface PipelineInventory {
  static_tif_exists: boolean
  risk_rasters: number
  latest_risk: string | null
  soil_rasters: number
  latest_soil: string | null
  rain_tifs: number
  rain_csvs: number
  latest_rain_csv: string | null
  max_risk_ready: boolean
  eta_ready: boolean
  street_ready: boolean
  has_rasterio: boolean
  has_pandas: boolean
}

interface PipelineStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  last_run: string | null
  last_result: any
  inventory?: PipelineInventory
  error?: string
}

interface Props {
  onClose: () => void
}

const STEP_LABELS: Record<string, string> = {
  static_tif:     '1. Static TIF',
  rainfall_csv:   '2. Rainfall CSV',
  rain_rasters:   '2. Rain rasters',
  soil_rasters:   '3. Soil rasters',
  risk_rasters:   '4. Risk rasters',
  eta:            '5. ETA raster',
  max_risk:       '6. Max-risk raster',
  street_geojson: '7. Street stats',
}

export default function ForecastPanel({ onClose }: Props) {
  const [status, setStatus]   = useState<PipelineStatus | null>(null)
  const [running, setRunning] = useState(false)
  const prevStateRef          = useRef<string | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/forecast/status')
      if (res.ok) setStatus(await res.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Poll while running
  useEffect(() => {
    if (status?.state !== 'running') return
    const id = setInterval(fetchStatus, 2000)
    return () => clearInterval(id)
  }, [status?.state, fetchStatus])

  // Final fetch when pipeline finishes (running → done/error) to get fresh inventory
  useEffect(() => {
    const prev = prevStateRef.current
    const curr = status?.state ?? null
    if (prev === 'running' && curr !== 'running') {
      // Small delay to let server finish writing status before we fetch
      const id = setTimeout(fetchStatus, 800)
      prevStateRef.current = curr
      return () => clearTimeout(id)
    }
    prevStateRef.current = curr
  }, [status?.state, fetchStatus])

  useEffect(() => {
    if (status?.state === 'running') setRunning(true)
    else setRunning(false)
  }, [status?.state])

  const runPipeline = async () => {
    setRunning(true)
    try {
      await fetch('/api/forecast/run', { method: 'POST' })
    } catch {}
    setTimeout(fetchStatus, 500)
  }

  const inv = status?.inventory

  const StateIcon = () => {
    if (running) return <RefreshCw size={13} className={styles.spinning} color="#a855f7" />
    if (status?.state === 'done') return <CheckCircle size={13} color="#22c55e" />
    if (status?.state === 'error') return <AlertTriangle size={13} color="#ef4444" />
    return <Clock size={13} color="#7a9ab5" />
  }

  const stateLabel = running ? 'Running pipeline…'
    : status?.state === 'done'  ? 'Ready'
    : status?.state === 'error' ? 'Error'
    : 'Idle'

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Sparkles size={14} color="#a855f7" />
          <span>48-Hour Forecast Engine</span>
        </div>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>

      {/* Status row */}
      <div className={styles.statusRow}>
        <StateIcon />
        <span className={styles.stateLabel} style={{
          color: running ? '#a855f7' : status?.state === 'done' ? '#22c55e' : status?.state === 'error' ? '#ef4444' : '#7a9ab5'
        }}>{stateLabel}</span>
        {status?.last_run && (
          <span className={styles.lastRun}>
            Last run: {new Date(status.last_run).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Error */}
      {status?.state === 'error' && (
        <div className={styles.errorBox}>
          {status.last_result?.error || status.error || 'Unknown error'}
        </div>
      )}

      {/* Inventory */}
      {inv && (
        <div className={styles.inventory}>
          <div className={styles.invTitle}>DATA INVENTORY</div>

          <div className={styles.invRow}>
            <Database size={10} />
            <span>Static TIF</span>
            <span className={styles.invVal} style={{ color: inv.static_tif_exists ? '#22c55e' : '#ef4444' }}>
              {inv.static_tif_exists ? '✓ Found' : '✗ Missing'}
            </span>
          </div>

          <div className={styles.invRow}>
            <CloudRain size={10} />
            <span>Rain rasters</span>
            <span className={styles.invVal} style={{ color: inv.rain_tifs > 0 ? '#22c55e' : '#7a9ab5' }}>
              {inv.rain_tifs} / 48
            </span>
          </div>

          <div className={styles.invRow}>
            <Layers size={10} />
            <span>Soil rasters</span>
            <span className={styles.invVal} style={{ color: inv.soil_rasters > 0 ? '#22c55e' : '#7a9ab5' }}>
              {inv.soil_rasters} / 48
            </span>
          </div>

          <div className={styles.invRow}>
            <Sparkles size={10} />
            <span>Risk rasters</span>
            <span className={styles.invVal} style={{ color: inv.risk_rasters > 0 ? '#22c55e' : '#7a9ab5' }}>
              {inv.risk_rasters} / 48
            </span>
          </div>

          {inv.latest_risk && (
            <div className={styles.invSub}>{inv.latest_risk}</div>
          )}

          <div className={styles.divider} />

          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>ETA raster</span>
            <span className={styles.invVal} style={{ color: inv.eta_ready ? '#22c55e' : '#7a9ab5' }}>
              {inv.eta_ready ? '✓ eta.tif' : '—'}
            </span>
          </div>

          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>Max-risk raster</span>
            <span className={styles.invVal} style={{ color: inv.max_risk_ready ? '#22c55e' : '#7a9ab5' }}>
              {inv.max_risk_ready ? '✓ max_risk.tif' : '—'}
            </span>
          </div>

          <div className={styles.invRow}>
            <MapPin size={10} />
            <span>Street stats</span>
            <span className={styles.invVal} style={{ color: inv.street_ready ? '#22c55e' : '#7a9ab5' }}>
              {inv.street_ready ? '✓ street.geojson' : '—'}
            </span>
          </div>

          <div className={styles.divider} />

          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>rasterio</span>
            <span className={styles.invVal} style={{ color: inv.has_rasterio ? '#22c55e' : '#ef4444' }}>
              {inv.has_rasterio ? '✓' : '✗ pip install rasterio'}
            </span>
          </div>
          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>pandas</span>
            <span className={styles.invVal} style={{ color: inv.has_pandas ? '#22c55e' : '#f97316' }}>
              {inv.has_pandas ? '✓' : '✗ pip install pandas'}
            </span>
          </div>
        </div>
      )}

      {/* Steps from last run */}
      {status?.last_result?.steps && (
        <div className={styles.steps}>
          <div className={styles.invTitle}>LAST RUN STEPS</div>
          {Object.entries(status.last_result.steps).map(([k, v]) => (
            <div key={k} className={styles.stepRow}>
              <span className={styles.stepKey}>{STEP_LABELS[k] ?? k.replace(/_/g, ' ')}</span>
              <span className={styles.stepVal}>
                {typeof v === 'string' ? v.split(/[/\\]/).pop()
                  : typeof v === 'number' ? `${v} files`
                  : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Run button */}
      <button
        className={styles.runBtn}
        onClick={runPipeline}
        disabled={running}
      >
        {running
          ? <><RefreshCw size={13} className={styles.spinning} /> Running pipeline…</>
          : <><Sparkles size={13} /> Run 48-Hour Forecast</>
        }
      </button>

      <div className={styles.hint}>
        Fetches 48-hr rainfall from Open-Meteo and soil moisture from NASA POWER,
        computes hourly risk rasters, then derives ETA, peak risk, and street-level stats.
        Previous outputs are cleared before each run.
      </div>
    </div>
  )
}
