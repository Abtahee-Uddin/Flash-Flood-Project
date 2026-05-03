import { useCallback, useRef, useState } from 'react'
import L from 'leaflet'

interface VectorFeature {
  osm_id: number
  name: string
  feature_type: 'road' | 'building'
  risk_score: number
  risk_level: string
  risk_pct: number
  risk_color: string
  depth_label: string
  lat: number
  lng: number
}

interface UseVectorOverlayReturn {
  loading: boolean
  error: string | null
  featureCount: number
  fetchAndRender: (map: L.Map, north: number, south: number, east: number, west: number) => Promise<void>
  clear: (map: L.Map) => void
}

export function useVectorOverlay(): UseVectorOverlayReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [featureCount, setFeatureCount] = useState(0)
  const layersRef = useRef<L.Layer[]>([])

  const clear = useCallback((map: L.Map) => {
    layersRef.current.forEach(l => map.removeLayer(l))
    layersRef.current = []
    setFeatureCount(0)
  }, [])

  const fetchAndRender = useCallback(async (
    map: L.Map,
    north: number, south: number, east: number, west: number
  ) => {
    // Clear old layers
    layersRef.current.forEach(l => map.removeLayer(l))
    layersRef.current = []

    setLoading(true)
    setError(null)

    try {
      const url = `/api/vector-risk?north=${north}&south=${south}&east=${east}&west=${west}&types=roads,buildings`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const geojson = await res.json()

      if (geojson.error) {
        setError(`OSM data unavailable: ${geojson.error}`)
        setLoading(false)
        return
      }

      const features: VectorFeature[] = (geojson.features || []).map((f: any) => ({
        ...f.properties,
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0],
      }))

      // Render each feature as a colored circle marker
      features.forEach(feat => {
        const isBuilding = feat.feature_type === 'building'
        const size = isBuilding ? 10 : 7
        const opacity = 0.75

        const marker = L.circleMarker([feat.lat, feat.lng], {
          radius: size,
          fillColor: feat.risk_color,
          color: feat.risk_color,
          fillOpacity: opacity,
          weight: isBuilding ? 1.5 : 1,
          opacity: opacity + 0.1,
        }).addTo(map)

        marker.bindTooltip(`
          <div style="font-family:'Space Mono',monospace;font-size:10px;min-width:150px;">
            <div style="color:${feat.risk_color};font-weight:700;margin-bottom:3px;">${feat.name}</div>
            <div style="color:#7a9ab5;">${isBuilding ? '▣ Building' : '⎔ Road'}</div>
            <div style="margin-top:4px;display:flex;gap:8px;align-items:center;">
              <span style="color:#7a9ab5;">STATIC FV</span>
              <span style="color:${feat.risk_color};font-weight:700;">${feat.risk_pct}%</span>
            </div>
            <div style="color:#7a9ab5;font-size:9px;margin-top:2px;">${feat.depth_label}</div>
          </div>
        `, { permanent: false, direction: 'top', offset: [0, -8], className: 'flood-tooltip' })

        layersRef.current.push(marker)
      })

      setFeatureCount(features.length)
    } catch (err) {
      setError('Could not load road/building data. Is the server running?')
    } finally {
      setLoading(false)
    }
  }, [])

  return { loading, error, featureCount, fetchAndRender, clear }
}
