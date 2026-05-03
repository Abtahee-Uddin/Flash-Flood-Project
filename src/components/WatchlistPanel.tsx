import { useState, useRef } from 'react'
import { WatchlistItem, UseWatchlistReturn } from '../hooks/useWatchlist'
import { UseFloodQueryReturn } from '../hooks/useFloodQuery'
import {
  X, Bell, BellOff, Trash2, Download, Upload,
  MapPin, RefreshCw, AlertTriangle, Edit2, Check
} from 'lucide-react'
import styles from './WatchlistPanel.module.css'

interface Props {
  watchlist: UseWatchlistReturn
  floodQuery: UseFloodQueryReturn
  onClose: () => void
  onFlyTo: (lat: number, lng: number) => void
  mapMode: 'static' | 'dynamic' | 'forecast' | 'historical'
}

const RISK_COLORS: Record<string, string> = {
  none: '#22c55e', low: '#84cc16', moderate: '#eab308',
  high: '#f97316', very_high: '#ef4444', unknown: '#7a9ab5',
}
const RISK_LABELS: Record<string, string> = {
  none: 'Safe', low: 'Low', moderate: 'Moderate',
  high: 'High', very_high: 'Very High', unknown: '—',
}

export default function WatchlistPanel({ watchlist, floodQuery, onClose, onFlyTo, mapMode }: Props) {
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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
    } catch {
      // server offline — keep existing values
    } finally {
      setRefreshingId(null)
    }
  }

  const refreshAll = async () => {
    for (const item of watchlist.items) {
      await refreshItem(item)
    }
  }

  const startEdit = (item: WatchlistItem) => {
    setEditingId(item.id)
    setEditName(item.name)
  }

  const saveEdit = (id: string) => {
    if (editName.trim()) watchlist.updateItem(id, { name: editName.trim() })
    setEditingId(null)
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const ok = watchlist.importJSON(text)
      setImportError(ok ? null : 'Invalid file format')
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const alertedCount = watchlist.items.filter(i => i.alertEnabled).length
  const highRiskAlerted = watchlist.items.filter(
    i => i.alertEnabled && (i.risk_level === 'high' || i.risk_level === 'very_high')
  )

  return (
    <div className={styles.panel}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <MapPin size={15} color="var(--accent-blue)" />
          <span>My Watchlist</span>
          {watchlist.items.length > 0 && (
            <span className={styles.countBadge}>{watchlist.items.length}</span>
          )}
        </div>
        <div className={styles.headerActions}>
          {watchlist.items.length > 0 && (
            <>
              <button className={styles.actionBtn} onClick={refreshAll} title="Refresh all risk scores">
                <RefreshCw size={13} />
              </button>
              <button className={styles.actionBtn} onClick={watchlist.exportJSON} title="Export watchlist as JSON">
                <Download size={13} />
              </button>
            </>
          )}
          <button className={styles.actionBtn} onClick={() => fileInputRef.current?.click()} title="Import watchlist from JSON">
            <Upload size={13} />
          </button>
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />
          <button className={styles.closeBtn} onClick={onClose}><X size={15} /></button>
        </div>
      </div>

      {/* Active alert warnings */}
      {highRiskAlerted.length > 0 && (
        <div className={styles.alertWarning}>
          <AlertTriangle size={12} color="#ef4444" />
          <span>{highRiskAlerted.length} watched location{highRiskAlerted.length > 1 ? 's' : ''} at high risk</span>
        </div>
      )}

      {/* Import error */}
      {importError && (
        <div className={styles.importError}>
          <X size={11} /> {importError}
          <button onClick={() => setImportError(null)}><X size={10} /></button>
        </div>
      )}

      {/* Mode context */}
      <div className={styles.modeNote}>
        {mapMode === 'static'     && '📍 Static vulnerability scores from GeoTIFF'}
        {mapMode === 'dynamic'    && '⚡ Dynamic live risk scores'}
        {mapMode === 'forecast'   && '✦ Forecast peak risk (live forecast)'}
        {mapMode === 'historical' && '⏱ Historical peak risk (Hurricane Ida, 2021-09-01)'}
      </div>

      {/* Empty state */}
      {watchlist.items.length === 0 && (
        <div className={styles.emptyState}>
          <MapPin size={32} color="var(--text-muted)" />
          <div className={styles.emptyTitle}>No saved locations</div>
          <div className={styles.emptyHint}>
            Search an address or click the map, then press <strong>+ Save to Watchlist</strong> to add it here.
          </div>
          <button className={styles.actionBtn} onClick={() => fileInputRef.current?.click()}>
            <Upload size={13} /> Import from JSON
          </button>
        </div>
      )}

      {/* Items */}
      {watchlist.items.length > 0 && (
        <div className={styles.itemList}>
          {watchlist.items.map(item => {
            const color = RISK_COLORS[item.risk_level] || '#7a9ab5'
            const isRefreshing = refreshingId === item.id
            const isEditing = editingId === item.id

            return (
              <div
                key={item.id}
                className={`${styles.item} ${item.alertEnabled && (item.risk_level === 'high' || item.risk_level === 'very_high') ? styles.itemAlert : ''}`}
                style={{ '--item-color': color } as React.CSSProperties}
              >
                {/* Color bar */}
                <div className={styles.itemBar} style={{ background: color }} />

                <div className={styles.itemBody}>
                  {/* Name row */}
                  <div className={styles.itemNameRow}>
                    {isEditing ? (
                      <div className={styles.editRow}>
                        <input
                          className={styles.editInput}
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') saveEdit(item.id); if (e.key === 'Escape') setEditingId(null) }}
                          autoFocus
                        />
                        <button className={styles.editSaveBtn} onClick={() => saveEdit(item.id)}><Check size={12} /></button>
                      </div>
                    ) : (
                      <>
                        <span className={styles.itemName}>{item.name}</span>
                        <button className={styles.editBtn} onClick={() => startEdit(item)} title="Rename">
                          <Edit2 size={10} />
                        </button>
                      </>
                    )}
                  </div>

                  {/* Address */}
                  <div className={styles.itemAddress}>
                    {item.address.split(',').slice(0, 3).join(', ')}
                  </div>

                  {/* Risk row */}
                  <div className={styles.itemRiskRow}>
                    {item.risk_pct !== null ? (
                      <>
                        <span className={styles.itemRiskPct} style={{ color }}>{item.risk_pct}%</span>
                        <span className={styles.itemRiskLabel} style={{ color }}>{RISK_LABELS[item.risk_level]}</span>
                        <span className={styles.itemDepth}>{item.depth_cm}</span>
                      </>
                    ) : (
                      <span className={styles.itemNoRisk}>Not yet checked</span>
                    )}
                    {isRefreshing && <RefreshCw size={10} className={styles.spinning} />}
                  </div>

                  {/* Coords */}
                  <div className={styles.itemCoords}>
                    {item.lat.toFixed(4)}, {item.lng.toFixed(4)}
                  </div>
                </div>

                {/* Actions */}
                <div className={styles.itemActions}>
                  <button
                    className={`${styles.itemBtn} ${item.alertEnabled ? styles.itemBtnAlert : ''}`}
                    onClick={() => watchlist.toggleAlert(item.id)}
                    title={item.alertEnabled ? 'Disable alert' : 'Enable alert'}
                  >
                    {item.alertEnabled ? <Bell size={13} /> : <BellOff size={13} />}
                  </button>
                  <button
                    className={styles.itemBtn}
                    onClick={() => { onFlyTo(item.lat, item.lng); refreshItem(item) }}
                    title="Fly to location"
                  >
                    <MapPin size={13} />
                  </button>
                  <button
                    className={`${styles.itemBtn} ${styles.itemBtnDelete}`}
                    onClick={() => watchlist.removeItem(item.id)}
                    title="Remove"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Footer */}
      {watchlist.items.length > 0 && (
        <div className={styles.footer}>
          <span>{alertedCount} alert{alertedCount !== 1 ? 's' : ''} active</span>
          <button className={styles.clearBtn} onClick={watchlist.clearAll}>Clear all</button>
        </div>
      )}
    </div>
  )
}
