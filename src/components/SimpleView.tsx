import { useState, useEffect, useRef, useCallback } from 'react'
import L from 'leaflet'
import { getRiskColor, RiskLevel } from '../utils/floodRisk'
import { WeatherData } from '../hooks/useWeatherData'
import { UseFloodQueryReturn } from '../hooks/useFloodQuery'
import { UseWatchlistReturn } from '../hooks/useWatchlist'
import { useVectorOverlay } from '../hooks/useVectorOverlay'
import { useRoadsOverlay } from '../hooks/useRoadsOverlay'
import { useBuildingsOverlay } from '../hooks/useBuildingsOverlay'
import MapSearch from './MapSearch'
import RiskPopup from './RiskPopup'
import WatchlistPanel from './WatchlistPanel'
import DynamicPanel from './DynamicPanel'
import ForecastPanel from './ForecastPanel'
import {
  Bell, X, Droplets, AlertTriangle,
  Wifi, WifiOff, Info, Layers, Server,
  Bookmark, Star, Zap, RefreshCw, Map as MapIcon, Activity, History
} from 'lucide-react'
import styles from './SimpleView.module.css'

interface HistoricalEvent {
  id: string
  name: string
  date: string
  dataset: string
  segments: number
  description: string
}

interface Props {
  weather: WeatherData
  onSwitchView: () => void
  floodQuery: UseFloodQueryReturn
  watchlist: UseWatchlistReturn
  mapMode: 'static' | 'dynamic' | 'forecast' | 'historical'
  setMapMode: (m: 'static' | 'dynamic' | 'forecast' | 'historical') => void
}

const RISK_LABELS: Record<string, string> = {
  very_high: 'Very High Risk', high: 'High Risk',
  moderate: 'Moderate Risk', low: 'Low Risk', none: 'Safe', unknown: 'Unknown'
}

const RISK_COLORS: Record<string, string> = {
  none: '#22c55e', low: '#84cc16', moderate: '#eab308',
  high: '#f97316', very_high: '#ef4444', unknown: '#7a9ab5',
}

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

function createPin(color: string, size = 18): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:${size}px;height:${size}px;background:${color};border:2.5px solid white;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,0.45);"></div>`,
    className: '', iconSize: [size, size], iconAnchor: [size / 2, size],
  })
}

function watchlistPin(color: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="position:relative;width:20px;height:24px;">
      <div style="width:16px;height:16px;background:${color};border:2.5px solid white;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,0.5);position:absolute;top:0;left:2px;"></div>
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid ${color};"></div>
    </div>`,
    className: '', iconSize: [20, 24], iconAnchor: [10, 24],
  })
}

export default function SimpleView({ weather, onSwitchView, floodQuery, watchlist, mapMode, setMapMode }: Props) {
  const mapElRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const clickMarkerRef = useRef<L.Marker | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const watchlistMarkersRef = useRef<Map<string, L.Marker>>(new Map())
  const mapModeRef = useRef<'static' | 'dynamic' | 'forecast' | 'historical'>(mapMode)
  const initialLoadDone = useRef(false)

  const [notifications, setNotifications] = useState<string[]>([])
  const [showWatchlist, setShowWatchlist] = useState(false)
  const [showDynPanel, setShowDynPanel]           = useState(false)
  const [showForecastPanel, setShowForecastPanel] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showTileOverlay, setShowTileOverlay] = useState(false)
  const [vectorLoading, setVectorLoading] = useState(false)
  const [scenario, setScenario] = useState<'none'|'light'|'heavy'|'extreme'>('none')
  const [vectorCount, setVectorCount] = useState(0)
  const [historicalEvents, setHistoricalEvents] = useState<HistoricalEvent[]>([])
  const [showHistoricalPicker, setShowHistoricalPicker] = useState(false)

  const vectorOverlay = useVectorOverlay()
  const roadsOverlay = useRoadsOverlay()
  const buildingsOverlay = useBuildingsOverlay()
  mapModeRef.current = mapMode  // always current, safe to read in stale closures

  useEffect(() => { floodQuery.checkServer() }, [])

  // Load available historical events once — currently just Hurricane Ida,
  // but the endpoint returns a list so adding more events later requires
  // no frontend changes.
  useEffect(() => {
    fetch('/api/historical/events')
      .then(r => r.ok ? r.json() : { events: [] })
      .then(data => setHistoricalEvents(data.events || []))
      .catch(() => setHistoricalEvents([]))
  }, [])

  // Init map
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return
    const map = L.map(mapElRef.current, { center: [40.737, -74.071], zoom: 13, zoomControl: false })
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap, © CARTO', subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)
    // Load Hudson County boundary + clip mask
    fetch('/hudson_county.geojson')
      .then(r => r.json())
      .then(geojson => {
        // Boundary outline
        L.geoJSON(geojson, {
          style: { color: '#38bdf8', weight: 2.5, fill: false, opacity: 0.7 }
        }).addTo(map)
        // Dark mask outside county
        const hudsonRings = geojson.features[0].geometry.coordinates.map(
          (polygon: number[][][]) => polygon[0].map(([lng, lat]: number[]) => [lat, lng] as [number, number])
        )
        const outerRing: [number, number][] = [[90,-180],[90,180],[-90,180],[-90,-180]]
        L.polygon([outerRing, ...hudsonRings], {
          color: 'transparent', fillColor: '#c8d8e8',
          fillOpacity: 0.72, weight: 0, interactive: false,
        }).addTo(map)
      })
      .catch(() => {}) // boundary load retried automatically on re-mount
    map.on('click', async (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng
      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current)
      clickMarkerRef.current = L.marker([lat, lng], { icon: createPin('#38bdf8') }).addTo(map)
      await floodQuery.queryPoint(lat, lng)
    })
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    mapRef.current = map

    // Load roads/buildings AFTER map is ready, using current mode from ref
    let mounted = true
    setTimeout(() => {
      if (!mounted) return  // component unmounted before timeout fired
      map.invalidateSize()
      const mode = mapModeRef.current
      console.log('[SimpleView] initial load, mode=', mode)
      initialLoadDone.current = true
      roadsOverlay.reload(map, mode)
      buildingsOverlay.refresh(map, mode)
      const _onMoveEnd = () => buildingsOverlay.refresh(map, mapModeRef.current)
      map.on('moveend', _onMoveEnd)
      ;(map as any)._buildingsMoveEnd = _onMoveEnd
    }, 100)

    return () => { mounted = false; map.remove(); mapRef.current = null }
  }, [])

  // TIF tile overlay toggles
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const shouldShow = mapMode === 'static' && showTileOverlay
    if (shouldShow && !tileLayerRef.current) {
      tileLayerRef.current = L.tileLayer('/api/tiles/{z}/{x}/{y}.png', { opacity: 0.65, maxZoom: 18, minZoom: 10 }).addTo(map)
    } else if (!shouldShow && tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current)
      tileLayerRef.current = null
    }
  }, [showTileOverlay, mapMode])

  // Mode switch — reload roads/buildings with correct endpoint + colors
  useEffect(() => {
    const map = mapRef.current
    if (!map || !initialLoadDone.current) return
    const effectiveMode = mapMode === 'static' && scenario !== 'none'
      ? `scenario:${scenario}` as any
      : mapMode
    console.log('[SimpleView] mode switch to', effectiveMode)
    roadsOverlay.reload(map, effectiveMode)
    buildingsOverlay.refresh(map, effectiveMode)
    if ((map as any)._buildingsMoveEnd) {
      map.off('moveend', (map as any)._buildingsMoveEnd)
    }
    const _onMoveEnd = () => buildingsOverlay.refresh(map, mapModeRef.current)
    map.on('moveend', _onMoveEnd)
    ;(map as any)._buildingsMoveEnd = _onMoveEnd
  }, [mapMode])

  const loadVectorOverlay = useCallback(async () => {
    const map = mapRef.current
    if (!map) return
    // Use containerPointToLatLng for accurate bounds regardless of pan state
    const size  = map.getSize()
    const sw    = map.containerPointToLatLng(L.point(0, size.y))
    const ne    = map.containerPointToLatLng(L.point(size.x, 0))
    setVectorLoading(true)
    await vectorOverlay.fetchAndRender(map, ne.lat, sw.lat, ne.lng, sw.lng)
    setVectorCount(vectorOverlay.featureCount)
    setVectorLoading(false)
  }, [vectorOverlay])

  // Reload when scenario changes (static mode only)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !initialLoadDone.current || mapMode !== 'static') return
    const effectiveMode = scenario !== 'none' ? `scenario:${scenario}` as any : 'static'
    roadsOverlay.reload(map, effectiveMode)
    buildingsOverlay.refresh(map, effectiveMode)
    floodQuery.setQueryMapMode(effectiveMode)
    watchlist.refreshAllRisk(effectiveMode)
  }, [scenario])

  // Watchlist markers on map
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    watchlistMarkersRef.current.forEach(m => map.removeLayer(m))
    watchlistMarkersRef.current.clear()
    watchlist.items.forEach(item => {
      const color = RISK_COLORS[item.risk_level] || '#38bdf8'
      const marker = L.marker([item.lat, item.lng], { icon: watchlistPin(color), zIndexOffset: 500 }).addTo(map)
      marker.bindTooltip(`
        <div style="font-family:'Space Mono',monospace;font-size:10px;min-width:140px;">
          <div style="color:${color};font-weight:700;margin-bottom:2px;">${item.name}</div>
          <div style="color:#7a9ab5;font-size:9px;">${item.address.split(',').slice(0,2).join(',')}</div>
          ${item.risk_pct !== null
            ? `<div style="margin-top:3px;color:${color};">${item.risk_pct}% — ${RISK_LABELS[item.risk_level]}</div>`
            : '<div style="color:#7a9ab5;margin-top:3px;">Not checked yet</div>'}
          ${item.alertEnabled ? '<div style="color:#38bdf8;font-size:8px;margin-top:2px;">🔔 Alert active</div>' : ''}
        </div>`, { permanent: false, direction: 'top', offset: [0, -12], className: 'flood-tooltip' })
      watchlistMarkersRef.current.set(item.id, marker)
    })
  }, [watchlist.items])

  // Alert notifications for watchlist
  useEffect(() => {
    watchlist.items.forEach(item => {
      if (item.alertEnabled && (item.risk_level === 'high' || item.risk_level === 'very_high')) {
        const msg = `⚠ ${item.name}: ${RISK_LABELS[item.risk_level]} (${item.risk_pct}%)`
        setNotifications(prev => prev.includes(msg) ? prev : [msg, ...prev].slice(0, 5))
      }
    })
  }, [watchlist.items])

  const handleSelectLocation = async (lat: number, lng: number, address: string) => {
    const map = mapRef.current
    if (map) {
      map.flyTo([lat, lng], 16, { animate: true, duration: 0.8 })
      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current)
      clickMarkerRef.current = L.marker([lat, lng], { icon: createPin('#38bdf8') }).addTo(map)
    }
    await floodQuery.queryPoint(lat, lng, address)
  }

  const flyTo = (lat: number, lng: number) => mapRef.current?.flyTo([lat, lng], 16, { animate: true, duration: 0.7 })

  const saveToWatchlist = () => {
    const r = floodQuery.queryResult
    if (!r || watchlist.hasItem(r.lat, r.lng)) return
    watchlist.addItem({
      name: r.address.split(',')[0] || 'Saved Location',
      address: r.address,
      lat: r.lat, lng: r.lng,
      alertEnabled: false,
      risk_score: r.risk_score,
      risk_level: r.risk_level,
      risk_pct: r.risk_pct,
      depth_label: r.depth.label,
      depth_cm: r.depth.cm,
    })
    if (clickMarkerRef.current && mapRef.current) {
      mapRef.current.removeLayer(clickMarkerRef.current)
      clickMarkerRef.current = null
    }
  }

  const alreadySaved = floodQuery.queryResult ? watchlist.hasItem(floodQuery.queryResult.lat, floodQuery.queryResult.lng) : false
  const overallRisk: RiskLevel = watchlist.items.some(i => i.risk_level === 'very_high') ? 'very_high'
    : watchlist.items.some(i => i.risk_level === 'high') ? 'high'
    : watchlist.items.some(i => i.risk_level === 'moderate') ? 'moderate' : 'low'
  const overallColor = getRiskColor(overallRisk)
  const watchlistAlertCount = watchlist.items.filter(i => i.alertEnabled).length

  return (
    <div className={styles.wrapper}>

      {/* Top Bar */}
      <div className={styles.topBar}>
        <div className={styles.topLeft}>
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <circle cx="14" cy="14" r="13" stroke="#38bdf8" strokeWidth="1.5"/>
            <path d="M6 18 C8 14 10 16 12 13 C14 10 16 15 18 12 C20 9 22 14 22 18" stroke="#38bdf8" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
            <path d="M6 21 C8 17 10 19 12 16 C14 13 16 18 18 15 C20 12 22 17 22 21" stroke="#ef4444" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.7"/>
          </svg>
          <div>
            <div className={styles.topTitle}>Flood Watch</div>
            <div className={styles.topSub}>Hudson County, NJ</div>
          </div>
        </div>

        <div className={styles.topCenter}>
          <div className={styles.modeToggle}>
            <button className={`${styles.modeBtn} ${mapMode === 'static' ? styles.modeBtnActive : ''}`} onClick={() => { setMapMode('static'); floodQuery.setQueryMapMode('static') }}>
              <MapIcon size={13} />
              <div className={styles.modeBtnText}>
                <span>Static</span>
                <span className={styles.modeSub}>Vulnerability</span>
              </div>
            </button>
            <button className={`${styles.modeBtn} ${mapMode === 'dynamic' ? styles.modeBtnActive : ''}`} onClick={() => { setMapMode('dynamic'); floodQuery.setQueryMapMode('dynamic') }}>
              <Zap size={13} />
              <div className={styles.modeBtnText}>
                <span>Dynamic</span>
                <span className={styles.modeSub}>Live Risk</span>
              </div>
            </button>
            <button className={`${styles.modeBtn} ${mapMode === 'forecast' ? styles.modeBtnActive : ''}`} onClick={() => { setMapMode('forecast'); floodQuery.setQueryMapMode('forecast') }}>
              <Activity size={13} />
              <div className={styles.modeBtnText}>
                <span>Forecast</span>
                <span className={styles.modeSub}>Peak + ETA</span>
              </div>
            </button>
            <button className={`${styles.modeBtn} ${mapMode === 'historical' ? styles.modeBtnActive : ''}`} onClick={() => { setMapMode('historical'); floodQuery.setQueryMapMode('historical') }}>
              <History size={13} />
              <div className={styles.modeBtnText}>
                <span>Historical</span>
                <span className={styles.modeSub}>Past Events</span>
              </div>
            </button>
          </div>
        </div>

        <div className={styles.topRight}>
          <div className={styles.viewToggle}>
            <button className={`${styles.viewBtn} ${styles.viewActive}`}>Simple</button>
            <button className={styles.viewBtn} onClick={onSwitchView}>Advanced</button>
          </div>
          {mapMode === 'dynamic' && (
            <button className={`${styles.iconBtn} ${showDynPanel ? styles.iconBtnActive : ''}`}
              onClick={() => setShowDynPanel(!showDynPanel)} title="Dynamic pipeline control">
              <Zap size={16} color={showDynPanel ? '#ef4444' : undefined} />
            </button>
          )}
          {mapMode === 'forecast' && (
            <button className={`${styles.iconBtn} ${showForecastPanel ? styles.iconBtnActive : ''}`}
              onClick={() => setShowForecastPanel(!showForecastPanel)} title="Run 48-hour forecast pipeline">
              <Activity size={16} color={showForecastPanel ? '#a855f7' : undefined} />
            </button>
          )}
          {mapMode === 'static' && (
            <>
              <button className={`${styles.iconBtn} ${showTileOverlay ? styles.iconBtnActive : ''}`} onClick={() => setShowTileOverlay(!showTileOverlay)} title="Toggle TIF heatmap overlay">
                <Layers size={16} />
              </button>
              <button className={`${styles.iconBtn} ${vectorLoading ? styles.iconBtnActive : ''}`} onClick={loadVectorOverlay} disabled={vectorLoading} title="Color roads & buildings in view">
                <RefreshCw size={16} className={vectorLoading ? styles.spinningIcon : ''} />
              </button>
            </>
          )}
          <button className={`${styles.iconBtn} ${showWatchlist ? styles.iconBtnActive : ''}`} onClick={() => setShowWatchlist(!showWatchlist)} title="My Watchlist">
            <Bookmark size={16} />
            {watchlist.items.length > 0 && <span className={styles.alertBadge}>{watchlist.items.length}</span>}
          </button>
          <button className={`${styles.iconBtn} ${showInfo ? styles.iconBtnActive : ''}`} onClick={() => setShowInfo(!showInfo)}>
            <Info size={16} />
          </button>
          <div className={styles.liveChip}>
            {weather.error ? <><WifiOff size={11}/> SIM</> : <><Wifi size={11}/> LIVE</>}
          </div>
          {!floodQuery.serverOnline && (
            <div className={styles.serverOfflineChip}><Server size={11}/> Offline</div>
          )}
        </div>
      </div>

      {/* Notifications */}
      {notifications.length > 0 && (
        <div className={styles.notifStack}>
          {notifications.map((msg, i) => (
            <div key={i} className={styles.notif}>
              <span>{msg}</span>
              <button onClick={() => setNotifications(p => p.filter((_, j) => j !== i))} className={styles.notifClose}><X size={12}/></button>
            </div>
          ))}
        </div>
      )}

      {/* Main layout: map + optional watchlist drawer */}
      <div className={styles.mainLayout}>
        <div className={styles.mapArea}>
          <div ref={mapElRef} className={styles.map} />

          {/* Search */}
          <div className={styles.searchOverlay}>
            <MapSearch query={floodQuery} onSelectLocation={handleSelectLocation} placeholder="Search any address in Hudson County..." variant="simple" />
          </div>

          {/* Mode banner */}
          <div className={`${styles.modeBanner} ${mapMode === 'dynamic' ? styles.modeBannerDynamic : ''} ${(mapMode === 'forecast' || mapMode === 'historical') ? styles.modeBannerForecast : ''}`}>
            {mapMode === 'static' && (
              <><MapIcon size={11}/> Static Vulnerability {roadsOverlay.loading && <span className={styles.vectorLoading}><RefreshCw size={9}/> roads...</span>}{roadsOverlay.loaded && <span className={styles.vectorCount}>{roadsOverlay.featureCount.toLocaleString()} roads</span>}{buildingsOverlay.buildingCount > 0 && <span className={styles.vectorCount}>{buildingsOverlay.buildingCount} bldgs</span>}{buildingsOverlay.loading && <span className={styles.vectorLoading}><RefreshCw size={9}/> bldgs...</span>}</>
            )}
            {mapMode === 'dynamic' && (
              <><Zap size={11} color="#ef4444"/> Dynamic Live Risk — rainfall + soil moisture (future live model)</>
            )}
            {mapMode === 'forecast' && (
              <><Activity size={11} color="#a855f7"/> Forecast — live peak risk + ETA{roadsOverlay.loaded && <span className={styles.vectorCount}>{roadsOverlay.featureCount.toLocaleString()} roads</span>}{buildingsOverlay.buildingCount > 0 && <span className={styles.vectorCount}>{buildingsOverlay.buildingCount} bldgs</span>}</>
            )}
            {mapMode === 'historical' && (
              <><History size={11} color="#a855f7"/> Historical — Hurricane Ida (2021-09-01) peak risk + ETA{roadsOverlay.loaded && <span className={styles.vectorCount}>{roadsOverlay.featureCount.toLocaleString()} roads</span>}{buildingsOverlay.buildingCount > 0 && <span className={styles.vectorCount}>{buildingsOverlay.buildingCount} bldgs</span>}</>
            )}
          </div>

          {/* Forecast ↔ Historical switcher — shown in either mode.
              Lets the user jump from a live forecast to a past event
              (currently Hurricane Ida), and back. */}
          {(mapMode === 'forecast' || mapMode === 'historical') && (
            <div className={styles.histSwitcher}>
              {mapMode === 'forecast' ? (
                <button
                  className={styles.histSwitchBtn}
                  onClick={() => {
                    if (historicalEvents.length <= 1) {
                      // Single event — jump straight to it
                      setMapMode('historical')
                      floodQuery.setQueryMapMode('historical')
                    } else {
                      setShowHistoricalPicker(v => !v)
                    }
                  }}
                  title="View a historical flood event"
                >
                  <History size={12} />
                  <span>Show historical flood events</span>
                  {historicalEvents.length > 0 && (
                    <span className={styles.histCount}>{historicalEvents.length}</span>
                  )}
                </button>
              ) : (
                <button
                  className={styles.histSwitchBtn}
                  onClick={() => { setMapMode('forecast'); floodQuery.setQueryMapMode('forecast') }}
                  title="Return to live forecast"
                >
                  <Activity size={12} />
                  <span>Back to live forecast</span>
                </button>
              )}

              {/* Event picker (only rendered when more than one event exists) */}
              {showHistoricalPicker && historicalEvents.length > 0 && (
                <div className={styles.histPicker}>
                  <div className={styles.histPickerTitle}>Historical events</div>
                  {historicalEvents.map(ev => (
                    <button
                      key={ev.id}
                      className={styles.histPickerItem}
                      onClick={() => {
                        setMapMode('historical')
                        floodQuery.setQueryMapMode('historical')
                        setShowHistoricalPicker(false)
                      }}
                    >
                      <div className={styles.histPickerName}>{ev.name}</div>
                      <div className={styles.histPickerMeta}>{ev.date}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Click hint */}
          {!floodQuery.queryResult && !floodQuery.querying && (
            <div className={styles.clickHint}>Click anywhere on the map to check flood risk</div>
          )}

          {/* Risk popup + save button */}
          {(floodQuery.queryResult || floodQuery.querying || floodQuery.queryError) && (
            <div className={styles.popupOverlay}>
              <RiskPopup result={floodQuery.queryResult} loading={floodQuery.querying} error={floodQuery.queryError} serverOnline={floodQuery.serverOnline}
                onClose={() => {
                  floodQuery.clearResult()
                  if (clickMarkerRef.current && mapRef.current) { mapRef.current.removeLayer(clickMarkerRef.current); clickMarkerRef.current = null }
                }} variant="simple" />
              {floodQuery.queryResult && (
                <button className={`${styles.saveBtn} ${alreadySaved ? styles.saveBtnDone : ''}`} onClick={saveToWatchlist} disabled={alreadySaved}>
                  {alreadySaved ? <><Star size={14}/> Saved</> : <><Bookmark size={14}/> Save to Watchlist</>}
                </button>
              )}
            </div>
          )}

          {/* Legend */}
          <div className={styles.legendOverlay}>
            <div className={styles.legendTitle}>
              {mapMode === 'static'     ? 'STATIC FV'
              : mapMode === 'forecast'   ? 'FORECAST PEAK'
              : mapMode === 'historical' ? 'IDA HINDCAST'
                                         : 'LIVE RISK'}
            </div>
            {['very_high','high','moderate','low','none'].map(level => (
              <div key={level} className={styles.legendItem}>
                <div className={styles.legendDot} style={{ background: RISK_COLORS[level] }}/>
                <span>{RISK_LABELS[level]}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Dynamic panel */}
        {showDynPanel && mapMode === 'dynamic' && (
          <div style={{ position:'absolute', top:'70px', right:'14px', zIndex:1500 }}>
            <DynamicPanel onClose={() => setShowDynPanel(false)} />
          </div>
        )}

        {/* Forecast panel */}
        {showForecastPanel && mapMode === 'forecast' && (
          <div style={{ position:'absolute', top:'70px', right:'14px', zIndex:1500 }}>
            <ForecastPanel onClose={() => setShowForecastPanel(false)} />
          </div>
        )}

        {/* Watchlist drawer */}
        {showWatchlist && (
          <div className={styles.watchlistDrawer}>
            <WatchlistPanel watchlist={watchlist} floodQuery={floodQuery} onClose={() => setShowWatchlist(false)} onFlyTo={flyTo} mapMode={mapMode} />
          </div>
        )}
      </div>

      {/* Bottom strip */}
      <div className={styles.bottomStrip}>
        <div className={styles.statusCard} style={{ borderColor: `${overallColor}40` }}>
          <div className={styles.statusLeft}>
            <div className={styles.statusDot} style={{ background: overallColor }}/>
            <div>
              <div className={styles.statusLabel}>County Status</div>
              <div className={styles.statusValue} style={{ color: overallColor }}>{RISK_LABELS[overallRisk]}</div>
            </div>
          </div>
          <div className={styles.statusRight}>
            <div className={styles.condPill}><Droplets size={12} color="#38bdf8"/><span>{weather.currentRainfall.toFixed(1)} mm/hr</span></div>
            {watchlist.items.filter(i => i.risk_level === 'high' || i.risk_level === 'very_high').length > 0 && (
              <div className={styles.condPill} style={{ borderColor: 'rgba(239,68,68,0.3)', color: '#ef4444' }}>
                <AlertTriangle size={12}/><span>{watchlist.items.filter(i => i.risk_level === 'high' || i.risk_level === 'very_high').length} high-risk</span>
              </div>
            )}
            {watchlistAlertCount > 0 && (
              <div className={styles.condPill} style={{ borderColor: 'rgba(56,189,248,0.3)', color: '#38bdf8' }}>
                <Bell size={12}/><span>{watchlistAlertCount} alert{watchlistAlertCount > 1 ? 's' : ''}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Info panel */}
      {showInfo && (
        <div className={styles.infoPanel}>
          <div className={styles.infoPanelHeader}>
            <span>About Flood Watch</span>
            <button onClick={() => setShowInfo(false)} className={styles.iconBtn}><X size={16}/></button>
          </div>
          <div className={styles.infoPanelBody}>
            <p><strong>Static mode</strong> — queries your <code>static_flood_vulnerability.tif</code> at any clicked or searched point. Use the overlay button to show the full heatmap, or the refresh button to color all visible roads and buildings.</p>
            <p><strong>Dynamic mode</strong> — reserved for a future live flood risk model. Currently shows estimates from rainfall and soil moisture data.</p>
            <p><strong>Watchlist</strong> — click any point on the map and press "Save to Watchlist" to track it. Enable alerts to be notified when risk rises. Export/import as JSON.</p>
            <div className={styles.infoFormula}>
              Static: GeoTIFF pixel → normalized 0–100%<br/>
              Dynamic: FV × (0.6 × Rain + 0.4 × Wetness)
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
              <div style={{ width:'8px', height:'8px', borderRadius:'50%', background: floodQuery.serverOnline ? '#22c55e' : '#ef4444' }}/>
              <span style={{ fontSize:'11px', color:'var(--text-muted)' }}>
                Python server: {floodQuery.serverOnline ? 'Online' : 'Offline — start server/server.py'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
