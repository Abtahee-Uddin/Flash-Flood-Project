import { useState, useEffect, useCallback } from 'react'
import { Zap, CheckCircle, AlertTriangle, Clock, Database, CloudRain, Layers } from 'lucide-react'
import styles from './DynamicPanel.module.css'

interface PipelineInventory {
  static_tif_exists: boolean
  risk_rasters: number
  latest_risk: string | null
  soil_rasters: number
  latest_soil: string | null
  rain_csvs: number
  latest_rain_csv: string | null
  max_risk_ready: boolean
  eta_ready: boolean
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

export default function DynamicPanel({ onClose }: Props) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/dynamic/status')
      if (res.ok) setStatus(await res.json())
    } catch {}
  }, [])

  // Poll while running
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // Only poll while pipeline is running
  useEffect(() => {
    if (status?.state !== 'running') return
    const id = setInterval(fetchStatus, 2000)
    return () => clearInterval(id)
  }, [status?.state, fetchStatus])

  const running = status?.state === 'running'

  const inv = status?.inventory

  const StateIcon = () => {
    if (running) return <RefreshCw size={13} className={styles.spinning} color="#38bdf8" />
    if (status?.state === 'done') return <CheckCircle size={13} color="#22c55e" />
    if (status?.state === 'error') return <AlertTriangle size={13} color="#ef4444" />
    return <Clock size={13} color="#7a9ab5" />
  }

  const stateLabel = running ? 'Running pipeline...'
    : status?.state === 'done' ? 'Ready'
    : status?.state === 'error' ? 'Error'
    : 'Idle'

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Zap size={14} color="#ef4444" />
          <span>Dynamic Risk Engine</span>
        </div>
        <button className={styles.closeBtn} onClick={onClose}>×</button>
      </div>

      {/* Status row */}
      <div className={styles.statusRow}>
        <StateIcon />
        <span className={styles.stateLabel} style={{
          color: running ? '#38bdf8' : status?.state === 'done' ? '#22c55e' : status?.state === 'error' ? '#ef4444' : '#7a9ab5'
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

          {inv.project_root && (
            <div className={styles.invRow}>
              <Database size={10} />
              <span>Project root</span>
              <span className={styles.invVal} style={{ fontSize:'7px', maxWidth:'140px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {inv.project_root.split(/[/\\]/).slice(-2).join('/')}
              </span>
            </div>
          )}
          <div className={styles.invRow}>
            <Database size={10} />
            <span>Static TIF</span>
            <span className={styles.invVal} style={{ color: inv.static_tif_exists ? '#22c55e' : '#ef4444' }}>
              {inv.static_tif_exists ? '✓ Found' : '✗ Missing'}
            </span>
          </div>

          <div className={styles.invRow}>
            <CloudRain size={10} />
            <span>Forecast rainfall CSVs</span>
            <span className={styles.invVal}>{inv.rain_csvs}</span>
          </div>
          {inv.latest_rain_csv && (
            <div className={styles.invSub}>{inv.latest_rain_csv}</div>
          )}

          <div className={styles.invRow}>
            <Layers size={10} />
            <span>Soil moisture rasters</span>
            <span className={styles.invVal}>{inv.soil_rasters}</span>
          </div>

          <div className={styles.invRow}>
            <Zap size={10} />
            <span>Risk rasters</span>
            <span className={styles.invVal} style={{ color: inv.risk_rasters > 0 ? '#22c55e' : '#7a9ab5' }}>
              {inv.risk_rasters}
            </span>
          </div>
          {inv.latest_risk && (
            <div className={styles.invSub}>{inv.latest_risk}</div>
          )}

          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>Max-risk raster</span>
            <span className={styles.invVal} style={{ color: inv.max_risk_ready ? '#22c55e' : '#7a9ab5' }}>
              {inv.max_risk_ready ? '✓' : '—'}
            </span>
          </div>

          <div className={styles.invRow}>
            <span style={{ width: 10 }} />
            <span>ETA raster</span>
            <span className={styles.invVal} style={{ color: inv.eta_ready ? '#22c55e' : '#7a9ab5' }}>
              {inv.eta_ready ? '✓' : '—'}
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
              {inv.has_pandas ? '✓' : '✗ conda install pandas'}
            </span>
          </div>
          {!inv.has_pandas && (
            <div className={styles.invSub} style={{ color:'#f97316' }}>
              Run in your conda env: conda install pandas
            </div>
          )}
        </div>
      )}

      {/* Pipeline steps from last run */}
      {status?.last_result?.steps && (
        <div className={styles.steps}>
          <div className={styles.invTitle}>LAST RUN STEPS</div>
          {Object.entries(status.last_result.steps).map(([k, v]) => (
            <div key={k} className={styles.stepRow}>
              <span className={styles.stepKey}>{k.replace(/_/g, ' ')}</span>
              <span className={styles.stepVal}>
                {typeof v === 'string' ? v.split(/[/\\]/).pop() : String(v)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={styles.hint}>
        Live dynamic risk uses real-time rainfall and soil moisture to compute
        current flood risk. To run the 48-hour forecast pipeline, switch to
        Forecast mode and click the ✦ FORECAST badge.
      </div>
    </div>
  )
}
