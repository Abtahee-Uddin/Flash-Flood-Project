import { useRef, useState, useCallback } from 'react'
import L from 'leaflet'

interface UseBuildingsOverlayReturn {
  loading: boolean
  error: string | null
  buildingCount: number
  refresh: (map: L.Map, mode?: 'static' | 'dynamic' | 'forecast' | 'historical') => void
  clear: (map: L.Map) => void
  enabled: boolean
  setEnabled: (v: boolean) => void
}

export function useBuildingsOverlay(): UseBuildingsOverlayReturn {
  const [loading, setLoading]             = useState(false)
  const [error, setError]                 = useState<string | null>(null)
  const [buildingCount, setBuildingCount] = useState(0)
  const [enabled, setEnabled]             = useState(true)

  const layerRef    = useRef<L.GeoJSON | null>(null)
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef    = useRef<AbortController | null>(null)
  const lastBboxRef = useRef('')
  const modeRef     = useRef<'static' | 'dynamic' | 'forecast' | 'historical'>('dynamic')

  const clear = useCallback((map: L.Map) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (abortRef.current) abortRef.current.abort()
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
    setBuildingCount(0)
    lastBboxRef.current = ''
  }, [])

  const refresh = useCallback((map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical' = 'static') => {
    const modeChanged = modeRef.current !== mode
    modeRef.current = mode
    if (!enabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    if (modeChanged) {
      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
      lastBboxRef.current = ''
      setBuildingCount(0)
    }
    timerRef.current = setTimeout(() => _doFetch(map), 400)
  }, [enabled])

  const _doFetch = useCallback(async (map: L.Map) => {
    const zoom = map.getZoom()
    if (zoom < 12) {
      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
      setBuildingCount(0)
      return
    }

    const size  = map.getSize()
    const sw    = map.containerPointToLatLng(L.point(0, size.y))
    const ne    = map.containerPointToLatLng(L.point(size.x, 0))
    const west  = sw.lng, south = sw.lat, east = ne.lng, north = ne.lat

    const bbox = [west.toFixed(3), south.toFixed(3), east.toFixed(3), north.toFixed(3)].join(',')
    if (bbox === lastBboxRef.current) return
    lastBboxRef.current = bbox

    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setError(null)

    try {
      const m = modeRef.current
      const isScenario = m.startsWith('scenario:')
      const base = isScenario
        ? '/api/scenario/buildings'
        : m === 'forecast'   ? '/api/forecast/buildings'
        : m === 'historical' ? '/api/historical/buildings'
        : m === 'dynamic'    ? '/api/dynamic/buildings'
                             : '/api/buildings'
      const scenarioQ = isScenario ? `&scenario=${m.replace('scenario:', '')}` : ''
      const url  = `${base}?west=${west}&south=${south}&east=${east}&north=${north}${scenarioQ}`
      const res  = await fetch(url, { signal: abortRef.current.signal })
      if (!res.ok) throw new Error(`${res.status}`)
      const geojson = await res.json()

      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
      if (!geojson.features?.length) { setBuildingCount(0); setLoading(false); return }

      const layer = L.geoJSON(geojson, {
        style: (feature) => ({
          color:       feature?.properties?.risk_color || '#334155',
          weight:      0.8,
          opacity:     0.9,
          fillColor:   feature?.properties?.risk_color || '#334155',
          fillOpacity: 0.4,
          interactive: false,
        }),
      }).addTo(map)

      layerRef.current = layer
      setBuildingCount(geojson.features.length)
    } catch (err: any) {
      if (err.name === 'AbortError') return
      setError('Buildings unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, error, buildingCount, refresh, clear, enabled, setEnabled }
}
