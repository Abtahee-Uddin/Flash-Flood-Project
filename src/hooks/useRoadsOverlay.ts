import { useRef, useState, useCallback } from 'react'
import L from 'leaflet'

interface UseRoadsOverlayReturn {
  loading: boolean
  loaded: boolean
  error: string | null
  featureCount: number
  load: (map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical') => Promise<void>
  reload: (map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical') => Promise<void>
  clear: (map: L.Map) => void
}

export function useRoadsOverlay(): UseRoadsOverlayReturn {
  const [loading, setLoading]           = useState(false)
  const [loaded, setLoaded]             = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [featureCount, setFeatureCount] = useState(0)

  // Keep one layer per mode — switching is instant after first load
  const layersRef   = useRef<Record<string, L.GeoJSON>>({})
  const activeMode  = useRef<string>('')
  const activeLayer = useRef<L.GeoJSON | null>(null)

  const clear = useCallback((map: L.Map) => {
    if (activeLayer.current) { map.removeLayer(activeLayer.current); activeLayer.current = null }
    // Also discard cached layers
    Object.values(layersRef.current).forEach(l => { try { map.removeLayer(l) } catch {} })
    layersRef.current = {}
    activeMode.current = ''
    setLoaded(false)
    setFeatureCount(0)
  }, [])

  const _showMode = useCallback((map: L.Map, mode: string) => {
    // Hide current layer
    if (activeLayer.current && activeLayer.current !== layersRef.current[mode]) {
      map.removeLayer(activeLayer.current)
    }
    // Show cached layer for this mode
    const layer = layersRef.current[mode]
    if (layer) {
      layer.addTo(map)
      activeLayer.current = layer
      activeMode.current  = mode
      setFeatureCount((layer as any)._featureCount || 0)
      setLoaded(true)
    }
  }, [])

  const _fetch = useCallback(async (map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical') => {
    setLoading(true)
    setError(null)
    // Immediately hide current layer while loading
    if (activeLayer.current) { map.removeLayer(activeLayer.current); activeLayer.current = null }
    try {
      const scenarioParam = (mode as any)?.startsWith?.('scenario:')
        ? `scenario=${(mode as any).replace('scenario:', '')}`
        : null
      const endpoint = scenarioParam
        ? `/api/scenario/roads?${scenarioParam}`
        : mode === 'forecast'   ? '/api/forecast/roads'
        : mode === 'historical' ? '/api/historical/roads'
        : mode === 'dynamic'    ? '/api/dynamic/roads'
                                : '/api/roads'
      console.log('[RoadsOverlay] fetching', endpoint)
      const res = await fetch(endpoint)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const geojson = await res.json()

      // Remove old cached layer for this mode if it exists
      if (layersRef.current[mode]) {
        try { map.removeLayer(layersRef.current[mode]) } catch {}
      }

      const layer = L.geoJSON(geojson, {
        style: (feature) => {
          const p  = feature?.properties || {}
          const rc = p.roadclass || 'S1400'
          return {
            color:       p.risk_color || '#888',
            weight:      rc === 'S1100' ? 3 : rc === 'S1200' ? 2 : 1.2,
            opacity:     rc === 'S1100' ? 0.95 : rc === 'S1200' ? 0.85 : 0.75,
            interactive: false,
          }
        },
      }).addTo(map)

      ;(layer as any)._featureCount = geojson.features?.length || 0
      layersRef.current[mode] = layer
      activeLayer.current     = layer
      activeMode.current      = mode
      setFeatureCount((layer as any)._featureCount)
      setLoaded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load roads')
    } finally {
      setLoading(false)
    }
  }, [])

  // load: use cache if available, otherwise fetch
  const load = useCallback(async (map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical') => {
    if (layersRef.current[mode]) {
      _showMode(map, mode)
      return
    }
    await _fetch(map, mode)
  }, [_fetch, _showMode])

  // reload: switch to cached version instantly, then refetch in background if dynamic
  const reload = useCallback(async (map: L.Map, mode: 'static' | 'dynamic' | 'forecast' | 'historical') => {
    if (activeMode.current === mode) return  // already showing correct mode
    if (layersRef.current[mode]) {
      // Instant switch from cache
      _showMode(map, mode)
      // Dynamic roads: always refetch to get latest weather-colored version.
      // Forecast roads are derived from static hindcast data — cache is fine.
      if (mode === 'dynamic') {
        await _fetch(map, mode)
      }
    } else {
      await _fetch(map, mode)
    }
  }, [_fetch, _showMode])

  return { loading, loaded, error, featureCount, load, reload, clear }
}
