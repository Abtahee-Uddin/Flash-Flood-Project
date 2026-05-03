import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import { UseFloodQueryReturn } from '../hooks/useFloodQuery'
import { UseWatchlistReturn, WatchlistItem } from '../hooks/useWatchlist'
import { useRoadsOverlay } from '../hooks/useRoadsOverlay'
import { useBuildingsOverlay } from '../hooks/useBuildingsOverlay'
import MapSearch from './MapSearch'
import DynamicPanel from './DynamicPanel'
import ForecastPanel from './ForecastPanel'
import RiskPopup from './RiskPopup'
import { MapMode } from '../App'
import styles from './MapView.module.css'

interface Props {
  mapMode: MapMode
  floodQuery: UseFloodQueryReturn
  watchlist: UseWatchlistReturn
  scenario?: string
}

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

const RISK_COLORS: Record<string, string> = {
  none: '#22c55e', low: '#84cc16', moderate: '#eab308',
  high: '#f97316', very_high: '#ef4444', unknown: '#7a9ab5',
}
const RISK_LABELS: Record<string, string> = {
  none: 'Safe', low: 'Low', moderate: 'Moderate',
  high: 'High', very_high: 'Very High', unknown: '—',
}

// World bbox minus Hudson County — used as clip mask fill
const WORLD_BBOX: [number, number][] = [
  [-90, -180], [-90, 180], [90, 180], [90, -180], [-90, -180]
]

function clickPin(): L.DivIcon {
  return L.divIcon({
    html: `<div style="width:14px;height:14px;background:#38bdf8;border:2.5px solid white;border-radius:50%;box-shadow:0 2px 8px rgba(0,0,0,0.45);"></div>`,
    className: '', iconSize: [14, 14], iconAnchor: [7, 7],
  })
}

function watchlistMarkerIcon(color: string, alertEnabled: boolean): L.DivIcon {
  const pulse = alertEnabled && (color === '#f97316' || color === '#ef4444')
  return L.divIcon({
    html: `<div style="position:relative;width:20px;height:24px;">
      ${pulse ? `<div style="position:absolute;inset:-6px;border-radius:50%;border:2px solid ${color};animation:ripple 2s ease-out infinite;opacity:0.4;"></div>` : ''}
      <div style="width:16px;height:16px;background:${color};border:2.5px solid white;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,0.5);position:absolute;top:0;left:2px;"></div>
      <div style="position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid ${color};"></div>
    </div>`,
    className: '', iconSize: [20, 24], iconAnchor: [10, 24],
  })
}

export default function MapView({ mapMode, floodQuery, watchlist, scenario = 'none' }: Props) {
  const mapElRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const clickMarkerRef = useRef<L.Marker | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)
  const watchlistMarkersRef = useRef<Map<string, L.Marker>>(new Map())
  const boundaryLayerRef = useRef<L.GeoJSON | null>(null)
  const clipMaskRef = useRef<L.GeoJSON | null>(null)
  const hudsonGeoJsonRef = useRef<any>(null)
  // Ref so stale closures (map click, marker click) always read current mapMode
  const mapModeRef = useRef<MapMode>(mapMode)
  const initialLoadDone = useRef(false)

  const roadsOverlay = useRoadsOverlay()
  const [showDynPanel, setShowDynPanel]      = useState(false)
  const [showForecastPanel, setShowForecastPanel] = useState(false)
  // Keep ref current whenever prop changes
  mapModeRef.current = mapMode
  const buildingsOverlay = useBuildingsOverlay()

  // ── Init map ───────────────────────────────────────────────
  useEffect(() => {
    if (!mapElRef.current || mapRef.current) return

    const map = L.map(mapElRef.current, {
      center: [40.737, -74.071], zoom: 13,
      zoomControl: false,   // disable default top-left zoom
      maxBounds: [[40.55, -74.35], [40.95, -73.85]],
      maxBoundsViscosity: 0.85,
    })

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap, © CARTO', subdomains: 'abcd', maxZoom: 19,
    }).addTo(map)

    // Load Hudson County GeoJSON — boundary + clip mask
    fetch('/hudson_county.geojson')
      .then(r => r.json())
      .then(geojson => {
        hudsonGeoJsonRef.current = geojson

        // 1. Draw county boundary outline
        const boundary = L.geoJSON(geojson, {
          style: {
            color: '#38bdf8', weight: 2.5,
            fill: false, opacity: 0.7,
          }
        }).addTo(map)
        boundaryLayerRef.current = boundary

        // 2. Build clip mask: world polygon with county hole punched out
        // Extract exterior ring coordinates from each polygon in the MultiPolygon
        const hudsonRings: [number, number][][] = []
        for (const polygon of geojson.features[0].geometry.coordinates) {
          // polygon[0] = exterior ring in [lng, lat]
          // Convert to [lat, lng] for Leaflet
          hudsonRings.push(polygon[0].map(([lng, lat]: number[]) => [lat, lng] as [number, number]))
        }

        // SVG clip approach: dark overlay polygon with hole
        // Using L.Polygon with holes
        const outerRing: [number, number][] = [
          [90, -180], [90, 180], [-90, 180], [-90, -180]
        ]
        const maskPolygon = L.polygon([outerRing, ...hudsonRings], {
          color: 'transparent',
          fillColor: '#c8d8e8',
          fillOpacity: 0.72,
          weight: 0,
          interactive: false,
        }).addTo(map)
        clipMaskRef.current = maskPolygon as any
      })
      .catch(() => {})

    // Click to query risk
    map.on('click', async (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng
      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current)
      clickMarkerRef.current = L.marker([lat, lng], { icon: clickPin() }).addTo(map)
      await floodQuery.queryPoint(lat, lng)
    })

    L.control.zoom({ position: 'bottomright' }).addTo(map)
    mapRef.current = map

    // Load roads + buildings immediately after map is ready
    let mounted = true
    setTimeout(() => {
      if (!mounted) return
      map.invalidateSize()
      const mode = mapModeRef.current
      console.log('[MapView] initial load, mode=', mode)
      initialLoadDone.current = true
      roadsOverlay.reload(map, mode)
      buildingsOverlay.refresh(map, mode)
      // No tile overlay in advanced view — roads/buildings color shows the mode
      const _onMoveEnd = () => buildingsOverlay.refresh(map, mapModeRef.current)
      map.on('moveend', _onMoveEnd)
      ;(map as any)._buildingsMoveEnd = _onMoveEnd
    }, 100)

    return () => { mounted = false; map.remove(); mapRef.current = null }
  }, [])

  // ── Mode switch (after initial mount) ─────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !initialLoadDone.current) return  // skip on first mount

    const effectiveMode = mapMode === 'static' && scenario !== 'none'
      ? `scenario:${scenario}` as any
      : mapMode
    console.log('[MapView] mode switch to', effectiveMode)

    // Reload roads + buildings with new mode colors (no tile overlay in advanced view)
    roadsOverlay.reload(map, effectiveMode)
    buildingsOverlay.refresh(map, effectiveMode)

    // Re-register moveend with current mode
    if ((map as any)._buildingsMoveEnd) {
      map.off('moveend', (map as any)._buildingsMoveEnd)
    }
    const _onMoveEnd = () => {
      const em = mapModeRef.current === 'static' && scenario !== 'none'
        ? `scenario:${scenario}` as any
        : mapModeRef.current
      buildingsOverlay.refresh(map, em)
    }
    map.on('moveend', _onMoveEnd)
    ;(map as any)._buildingsMoveEnd = _onMoveEnd
  }, [mapMode, scenario])

  // Reload on scenario change
  useEffect(() => {
    const map = mapRef.current
    if (!map || !initialLoadDone.current || mapMode !== 'static') return
    const effectiveMode = scenario !== 'none' ? `scenario:${scenario}` as any : 'static'
    roadsOverlay.reload(map, effectiveMode)
    buildingsOverlay.refresh(map, effectiveMode)
  }, [scenario])

  // ── Watchlist markers ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    watchlistMarkersRef.current.forEach(m => map.removeLayer(m))
    watchlistMarkersRef.current.clear()

    watchlist.items.forEach((item: WatchlistItem) => {
      const color = RISK_COLORS[item.risk_level] || '#38bdf8'
      const marker = L.marker([item.lat, item.lng], {
        icon: watchlistMarkerIcon(color, item.alertEnabled),
        zIndexOffset: 400,
      }).addTo(map)

      marker.bindTooltip(`
        <div style="font-family:'Space Mono',monospace;font-size:10px;min-width:150px;">
          <div style="color:${color};font-weight:700;margin-bottom:3px;">${item.name}</div>
          <div style="color:#7a9ab5;font-size:9px;">${item.address.split(',').slice(0,2).join(',')}</div>
          ${item.risk_pct !== null
            ? `<div style="margin-top:4px;display:flex;align-items:center;gap:8px;">
                <span style="color:${color};font-weight:700;font-size:14px;">${item.risk_pct}%</span>
                <span style="color:${color};">${RISK_LABELS[item.risk_level]}</span>
               </div>
               <div style="color:#7a9ab5;font-size:9px;margin-top:2px;">${item.depth_label}</div>`
            : '<div style="color:#7a9ab5;margin-top:3px;font-size:9px;">Click to check risk</div>'
          }
          ${item.alertEnabled ? '<div style="color:#38bdf8;font-size:8px;margin-top:3px;">🔔 Alert active</div>' : ''}
        </div>
      `, { permanent: false, direction: 'top', offset: [0, -14], className: 'flood-tooltip' })

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e)
        floodQuery.queryPoint(item.lat, item.lng, item.address)
      })

      watchlistMarkersRef.current.set(item.id, marker)
    })
  }, [watchlist.items, mapMode])

  const handleSelectLocation = async (lat: number, lng: number, address: string) => {
    const map = mapRef.current
    if (map) {
      map.flyTo([lat, lng], 16, { animate: true, duration: 0.8 })
      if (clickMarkerRef.current) map.removeLayer(clickMarkerRef.current)
      clickMarkerRef.current = L.marker([lat, lng], { icon: clickPin() }).addTo(map)
    }
    await floodQuery.queryPoint(lat, lng, address)
  }

  return (
    <div className={styles.mapWrapper}>
      <div ref={mapElRef} className={styles.map} />

      {/* Search bar */}
      <div className={styles.advancedSearch}>
        <MapSearch
          query={floodQuery}
          onSelectLocation={handleSelectLocation}
          placeholder="Search address..."
          variant="advanced"
        />
      </div>

      {/* Dynamic panel */}
      {showDynPanel && mapMode === 'dynamic' && (
        <div style={{ position:'absolute', top:'50px', right:'10px', zIndex:1500 }}>
          <DynamicPanel onClose={() => setShowDynPanel(false)} />
        </div>
      )}

      {/* Forecast panel */}
      {showForecastPanel && mapMode === 'forecast' && (
        <div style={{ position:'absolute', top:'50px', right:'10px', zIndex:1500 }}>
          <ForecastPanel onClose={() => setShowForecastPanel(false)} />
        </div>
      )}

      {/* Mode + roads status badge */}
      <div className={`${styles.modeBadge} ${mapMode === 'dynamic' ? styles.modeBadgeDynamic : ''} ${(mapMode === 'forecast' || mapMode === 'historical') ? styles.modeBadgeForecast : ''}`}>
        {mapMode === 'static' && (
          <>▣ STATIC VULNERABILITY{roadsOverlay.loading && ' — loading roads...'}{roadsOverlay.loaded && ` — ${roadsOverlay.featureCount.toLocaleString()} roads`}{buildingsOverlay.buildingCount > 0 && `, ${buildingsOverlay.buildingCount} buildings`}{buildingsOverlay.loading && ' — loading bldgs...'}</>
        )}
        {mapMode === 'dynamic' && (
          <span style={{cursor:'pointer'}} onClick={() => setShowDynPanel(p => !p)}>
            ⚡ DYNAMIC LIVE RISK — click to manage pipeline
          </span>
        )}
        {mapMode === 'forecast' && (
          <span style={{cursor:'pointer'}} onClick={() => setShowForecastPanel(p => !p)}>
            ✦ FORECAST — click to run pipeline{roadsOverlay.loading && ' — loading roads...'}{roadsOverlay.loaded && ` — ${roadsOverlay.featureCount.toLocaleString()} roads`}{buildingsOverlay.buildingCount > 0 && `, ${buildingsOverlay.buildingCount} buildings`}
          </span>
        )}
        {mapMode === 'historical' && (
          <>⏱ HISTORICAL — Hurricane Ida (2021-09-01) hindcast{roadsOverlay.loading && ' — loading roads...'}{roadsOverlay.loaded && ` — ${roadsOverlay.featureCount.toLocaleString()} roads`}{buildingsOverlay.buildingCount > 0 && `, ${buildingsOverlay.buildingCount} buildings`}</>
        )}
      </div>

      {/* Roads error */}
      {roadsOverlay.error && (
        <div className={styles.roadsError}>{roadsOverlay.error}</div>
      )}

      {/* Risk popup */}
      {(floodQuery.queryResult || floodQuery.querying || floodQuery.queryError) && (
        <div className={styles.clickPopup}>
          <RiskPopup
            result={floodQuery.queryResult}
            loading={floodQuery.querying}
            error={floodQuery.queryError}
            serverOnline={floodQuery.serverOnline}
            onClose={() => {
              floodQuery.clearResult()
              if (clickMarkerRef.current && mapRef.current) {
                mapRef.current.removeLayer(clickMarkerRef.current)
                clickMarkerRef.current = null
              }
            }}
            variant="advanced"
          />
          {floodQuery.queryResult && !watchlist.hasItem(floodQuery.queryResult.lat, floodQuery.queryResult.lng) && (
            <button
              className={styles.saveBtn}
              onClick={() => {
                const r = floodQuery.queryResult!
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
                floodQuery.clearResult()
              }}
            >
              + Save to Watchlist
            </button>
          )}
        </div>
      )}

      <div className={styles.scanLine} />
    </div>
  )
}
