import { useState } from 'react'
import { UseWatchlistReturn, WatchlistItem } from '../hooks/useWatchlist'
import { UseFloodQueryReturn } from '../hooks/useFloodQuery'
import { WeatherData } from '../hooks/useWeatherData'
import {
  MapPin, Bell, BellOff, Trash2, RefreshCw, CloudRain,
  Droplets, Bookmark, AlertTriangle, Edit2, Check, X, Download, Upload
} from 'lucide-react'
import styles from './Sidebar.module.css'

interface Props {
  watchlist: UseWatchlistReturn
  floodQuery: UseFloodQueryReturn
  weather: WeatherData
  mapMode: 'static' | 'dynamic' | 'forecast' | 'historical'
}

const RISK_COLORS: Record<string, string> = {
  none: '#22c55e', low: '#84cc16', moderate: '#eab308',
  high: '#f97316', very_high: '#ef4444', unknown: '#7a9ab5',
}
const RISK_LABELS: Record<string, string> = {
  none: 'NONE', low: 'LOW', moderate: 'MODERATE',
  high: 'HIGH', very_high: 'VERY HIGH', unknown: '—',
}
const RISK_ORDER: Record<string, number> = {
  very_high: 0, high: 1, moderate: 2, low: 3, none: 4, unknown: 5
}

export default function Sidebar({ watchlist, floodQuery, weather, mapMode }: Props) {
  const [sortBy, setSortBy] = useState<'risk' | 'name' | 'added'>('risk')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const fileInputRef = { current: null as HTMLInputElement | null }

  const sorted = [...watchlist.items].sort((a, b) => {
    if (sortBy === 'risk') return (RISK_ORDER[a.risk_level] ?? 5) - (RISK_ORDER[b.risk_level] ?? 5)
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    return b.addedAt - a.addedAt
  })

  const refreshItem = async (item: WatchlistItem) => {
    setRefreshingId(item.id)
    try {
      const endpoint =
        mapMode === 'forecast'   ? '/api/forecast/risk' :
        mapMode === 'historical' ? '/api/historical/risk' :
        mapMode === 'dynamic'    ? '/api/dynamic/risk'  :
                                    '/api/risk'
      const res = await fetch(`${endpoint}?lat=${item.lat}&lng=${item.lng}`)
      if (res.ok) {
        const data = await res.json()
        watchlist.updateItem(item.id, {
          risk_score: data.risk_score,
          risk_level: data.risk_level,
          risk_pct: data.risk_pct,
          depth_label: data.depth?.label || '',
          depth_cm: data.depth?.cm || '',
        })
      }
    } catch {}
    setRefreshingId(null)
  }

  const saveEdit = (id: string) => {
    if (editName.trim()) watchlist.updateItem(id, { name: editName.trim() })
    setEditingId(null)
  }

  const riskCounts = {
    very_high: watchlist.items.filter(i => i.risk_level === 'very_high').length,
    high: watchlist.items.filter(i => i.risk_level === 'high').length,
    moderate: watchlist.items.filter(i => i.risk_level === 'moderate').length,
    low: watchlist.items.filter(i => i.risk_level === 'low').length,
    none: watchlist.items.filter(i => i.risk_level === 'none').length,
  }

  return (
    <aside className={styles.sidebar}>

      {/* Weather summary */}
      <div className={styles.weatherPanel}>
        <div className={styles.panelHeader}>
          <CloudRain size={13} color="var(--accent-blue)" />
          <span>CURRENT CONDITIONS</span>
        </div>
        <div className={styles.weatherGrid}>
          <div className={styles.weatherCell}>
            <div className={styles.weatherLabel}>RAINFALL</div>
            <div className={styles.weatherValue}>{weather.currentRainfall.toFixed(1)}<span className={styles.weatherUnit}>mm/hr</span></div>
          </div>
          <div className={styles.weatherCell}>
            <div className={styles.weatherLabel}>SOIL MOISTURE</div>
            <div className={styles.weatherValue}>{(weather.soilMoisture * 100).toFixed(0)}<span className={styles.weatherUnit}>%</span></div>
          </div>
          <div className={styles.weatherCell}>
            <div className={styles.weatherLabel}>RAIN FACTOR</div>
            <div className={styles.weatherValue}>{Math.min(1, weather.currentRainfall / 50).toFixed(2)}</div>
          </div>
          <div className={styles.weatherCell}>
            <div className={styles.weatherLabel}>MODE</div>
            <div
              className={styles.weatherValue}
              style={{
                fontSize: '11px',
                color: mapMode === 'static'     ? 'var(--accent-blue)'
                     : mapMode === 'forecast'   ? '#a855f7'
                     : mapMode === 'historical' ? '#c4b5fd'
                                                : '#ef4444',
              }}
            >
              {mapMode === 'static'     ? 'STATIC'
               : mapMode === 'forecast'   ? 'FORECAST'
               : mapMode === 'historical' ? 'HISTORICAL'
                                          : 'DYNAMIC'}
            </div>
          </div>
        </div>
      </div>

      {/* Risk distribution */}
      {watchlist.items.length > 0 && (
        <div className={styles.distPanel}>
          <div className={styles.panelHeader}>
            <AlertTriangle size={13} color="var(--accent-blue)" />
            <span>RISK DISTRIBUTION</span>
          </div>
          <div className={styles.distBars}>
            {(['very_high','high','moderate','low','none'] as const).map(level => {
              const count = riskCounts[level]
              const pct = watchlist.items.length > 0 ? (count / watchlist.items.length) * 100 : 0
              return (
                <div key={level} className={styles.distRow}>
                  <span className={styles.distLabel} style={{ color: RISK_COLORS[level] }}>{RISK_LABELS[level]}</span>
                  <div className={styles.distBarTrack}>
                    <div className={styles.distBarFill} style={{ width: `${pct}%`, background: RISK_COLORS[level] }} />
                  </div>
                  <span className={styles.distCount}>{count}</span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Watchlist header */}
      <div className={styles.listHeader}>
        <div className={styles.listHeaderLeft}>
          <Bookmark size={13} color="var(--accent-blue)" />
          <span>WATCHLIST</span>
          {watchlist.items.length > 0 && (
            <span className={styles.countBadge}>{watchlist.items.length}</span>
          )}
        </div>
        <div className={styles.listHeaderRight}>
          <select
            className={styles.sortSelect}
            value={sortBy}
            onChange={e => setSortBy(e.target.value as any)}
          >
            <option value="risk">By Risk</option>
            <option value="name">By Name</option>
            <option value="added">Recently Added</option>
          </select>
          <button className={styles.iconActionBtn} onClick={watchlist.exportJSON} title="Export JSON">
            <Download size={12} />
          </button>
        </div>
      </div>

      {/* Empty state */}
      {watchlist.items.length === 0 && (
        <div className={styles.emptyState}>
          <MapPin size={28} color="var(--text-muted)" />
          <div className={styles.emptyTitle}>No saved locations</div>
          <div className={styles.emptyHint}>
            Switch to Simple view, click the map or search an address, then press <strong>Save to Watchlist</strong>.
          </div>
        </div>
      )}

      {/* Item list */}
      <div className={styles.itemList}>
        {sorted.map(item => {
          const color = RISK_COLORS[item.risk_level] || '#7a9ab5'
          const isRefreshing = refreshingId === item.id
          const isEditing = editingId === item.id

          return (
            <div
              key={item.id}
              className={styles.item}
              style={{ '--c': color } as React.CSSProperties}
              onClick={() => floodQuery.queryPoint(item.lat, item.lng, item.address)}
            >
              <div className={styles.itemBar} style={{ background: color }} />

              <div className={styles.itemBody}>
                {/* Name */}
                {isEditing ? (
                  <div className={styles.editRow} onClick={e => e.stopPropagation()}>
                    <input
                      className={styles.editInput}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') setEditingId(null) }}
                      autoFocus
                    />
                    <button className={styles.editSave} onClick={() => saveEdit(item.id)}><Check size={11} /></button>
                    <button className={styles.editCancel} onClick={() => setEditingId(null)}><X size={11} /></button>
                  </div>
                ) : (
                  <div className={styles.itemNameRow}>
                    <span className={styles.itemName}>{item.name}</span>
                    <button className={styles.editBtn} onClick={e => { e.stopPropagation(); setEditingId(item.id); setEditName(item.name) }}>
                      <Edit2 size={9} />
                    </button>
                  </div>
                )}

                {/* Address */}
                <div className={styles.itemAddress}>{item.address.split(',').slice(0, 2).join(',')}</div>

                {/* Risk */}
                <div className={styles.itemRiskRow}>
                  {item.risk_pct !== null ? (
                    <>
                      <span className={styles.riskPct} style={{ color }}>{item.risk_pct}%</span>
                      <span className={styles.riskLabel} style={{ color }}>{RISK_LABELS[item.risk_level]}</span>
                      <span className={styles.riskDepth}>{item.depth_cm}</span>
                    </>
                  ) : (
                    <span className={styles.riskUnknown}>Not checked — click to query</span>
                  )}
                  {isRefreshing && <RefreshCw size={9} className={styles.spinning} />}
                </div>

                {/* Coords */}
                <div className={styles.itemCoords}>{item.lat.toFixed(4)}, {item.lng.toFixed(4)}</div>
              </div>

              {/* Actions */}
              <div className={styles.itemActions} onClick={e => e.stopPropagation()}>
                <button
                  className={`${styles.actionBtn} ${item.alertEnabled ? styles.actionBtnAlert : ''}`}
                  onClick={() => watchlist.toggleAlert(item.id)}
                  title={item.alertEnabled ? 'Disable alert' : 'Enable alert'}
                >
                  {item.alertEnabled ? <Bell size={11} /> : <BellOff size={11} />}
                </button>
                <button
                  className={styles.actionBtn}
                  onClick={() => refreshItem(item)}
                  title="Refresh risk"
                >
                  <RefreshCw size={11} />
                </button>
                <button
                  className={`${styles.actionBtn} ${styles.actionBtnDelete}`}
                  onClick={() => watchlist.removeItem(item.id)}
                  title="Remove"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
