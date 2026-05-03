import { useState, useCallback, useRef } from 'react'

export interface RiskQueryResult {
  lat: number
  lng: number
  address: string
  risk_score: number | null
  risk_level: string
  risk_pct: number | null
  depth: { label: string; cm: string }
  in_bounds: boolean
  source: string
  weather?: {
    rain_mm: number
    rain_factor: number
    soil_norm: number
    hour: string
  }
  static_fv?: number
  // Hindcast street-level data (Hurricane Ida)
  hindcast?: {
    max_risk: number | null
    eta_hour: number | null
    eta_label: string | null
    name: string | null
    highway: string | null
    dist_m: number
  }
}

export interface SearchSuggestion {
  display_name: string
  lat: string
  lon: string
  type: string
  address?: {
    road?: string
    suburb?: string
    city?: string
    state?: string
    postcode?: string
  }
}

export interface UseFloodQueryReturn {
  // Address search
  searchQuery: string
  setSearchQuery: (q: string) => void
  suggestions: SearchSuggestion[]
  searchLoading: boolean
  searchError: string | null
  fetchSuggestions: (q: string) => void
  clearSearch: () => void

  // Risk query (click or search)
  querying: boolean
  queryResult: RiskQueryResult | null
  queryError: string | null
  queryPoint: (lat: number, lng: number, address?: string) => Promise<void>
  clearResult: () => void

  // Map mode — stored here so all callers use the same mode
  mapMode: 'static' | 'dynamic' | 'forecast' | 'historical'
  setQueryMapMode: (m: 'static' | 'dynamic' | 'forecast' | 'historical') => void

  // Server status
  serverOnline: boolean
  checkServer: () => void
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
const SEARCH_BOUNDS  = '40.685,-74.130,40.792,-74.020'

export function useFloodQuery(): UseFloodQueryReturn {
  const [searchQuery, setSearchQuery]   = useState('')
  const [suggestions, setSuggestions]   = useState<SearchSuggestion[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError]   = useState<string | null>(null)

  const [querying, setQuerying]         = useState(false)
  const [queryResult, setQueryResult]   = useState<RiskQueryResult | null>(null)
  const [queryError, setQueryError]     = useState<string | null>(null)

  const [serverOnline, setServerOnline] = useState(true)

  // mapMode lives here — single source of truth, no stale closure risk
  const [mapMode, setMapMode]           = useState<'static' | 'dynamic' | 'forecast' | 'historical'>('dynamic')
  const mapModeRef                      = useRef<'static' | 'dynamic' | 'forecast' | 'historical'>('dynamic')

  const setQueryMapMode = useCallback((m: 'static' | 'dynamic' | 'forecast' | 'historical') => {
    setMapMode(m)
    mapModeRef.current = m
  }, [])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Nominatim address autocomplete ──────────────────────────
  const fetchSuggestions = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim() || q.length < 3) { setSuggestions([]); return }

    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      setSearchError(null)
      try {
        const query = q.toLowerCase().includes('hudson') || q.toLowerCase().includes('jersey')
          ? q : `${q}, Hudson County, NJ`
        const url = `${NOMINATIM_BASE}/search?` + new URLSearchParams({
          q: query, format: 'json', addressdetails: '1', limit: '7',
          countrycodes: 'us', viewbox: SEARCH_BOUNDS, bounded: '0',
        })
        const res = await fetch(url, {
          headers: { 'Accept-Language': 'en-US,en', 'User-Agent': 'HudsonFloodApp/1.0' }
        })
        if (!res.ok) throw new Error('Geocoder unavailable')
        setSuggestions((await res.json()).slice(0, 7))
      } catch {
        setSearchError('Address search unavailable')
        setSuggestions([])
      } finally {
        setSearchLoading(false)
      }
    }, 350)
  }, [])

  const clearSearch = useCallback(() => {
    setSearchQuery('')
    setSuggestions([])
    setSearchError(null)
  }, [])

  // ── Risk query — always uses mapModeRef.current ──────────────
  const queryPoint = useCallback(async (lat: number, lng: number, address = '') => {
    setQuerying(true)
    setQueryError(null)

    // Read from ref — immune to stale closure
    const mode     = mapModeRef.current
    const endpoint = mode === 'forecast'
      ? `/api/forecast/risk?lat=${lat}&lng=${lng}`
      : mode === 'historical'
        ? `/api/historical/risk?lat=${lat}&lng=${lng}`
      : mode === 'dynamic'
        ? `/api/dynamic/risk?lat=${lat}&lng=${lng}`
        : `/api/risk?lat=${lat}&lng=${lng}`

    console.log(`[FloodQuery] mode=${mode} → ${endpoint}`)

    try {
      const riskRes = await fetch(endpoint)
      if (!riskRes.ok) throw new Error(`Server error ${riskRes.status}`)
      const data = await riskRes.json()

      // /api/forecast/risk already embeds a `hindcast` block on the response;
      // static + dynamic intentionally do not include hindcast fields.
      setQueryResult({
        ...data,
        lat:       data.lat       ?? lat,
        lng:       data.lng       ?? lng,
        address:   address || data.address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        in_bounds: data.in_bounds ?? isInHudson(lat, lng),
        hindcast:  data.hindcast,
      })
      setServerOnline(true)
    } catch (err) {
      setServerOnline(false)
      setQueryError('Flood server offline. Start server/server.py first.')
      const mockScore = _mockRisk(lat, lng)
      setQueryResult({
        lat, lng,
        address:    address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        risk_score: mockScore,
        risk_level: scoreToLevel(mockScore),
        risk_pct:   Math.round(mockScore * 100),
        depth:      depthForLevel(scoreToLevel(mockScore)),
        in_bounds:  isInHudson(lat, lng),
        source:     'mock',
      })
    } finally {
      setQuerying(false)
    }
  }, [])  // no deps needed — reads mapModeRef.current at call time

  const clearResult = useCallback(() => {
    setQueryResult(null)
    setQueryError(null)
  }, [])

  const checkServer = useCallback(async () => {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(2000) })
      setServerOnline(res.ok)
    } catch {
      setServerOnline(false)
    }
  }, [])

  return {
    searchQuery, setSearchQuery,
    suggestions, searchLoading, searchError,
    fetchSuggestions, clearSearch,
    querying, queryResult, queryError,
    queryPoint, clearResult,
    mapMode, setQueryMapMode,
    serverOnline, checkServer,
  }
}

// ── Utilities ──────────────────────────────────────────────────
function isInHudson(lat: number, lng: number): boolean {
  return lat >= 40.685 && lat <= 40.792 && lng >= -74.130 && lng <= -74.020
}

function scoreToLevel(score: number): string {
  if (score < 0.2) return 'none'
  if (score < 0.4) return 'low'
  if (score < 0.6) return 'moderate'
  if (score < 0.8) return 'high'
  return 'very_high'
}

function depthForLevel(level: string): { label: string; cm: string } {
  const map: Record<string, { label: string; cm: string }> = {
    none:      { label: 'No flooding expected',        cm: '0 cm' },
    low:       { label: 'Minor puddles possible',      cm: '0–5 cm' },
    moderate:  { label: 'Shallow street water',        cm: '5–15 cm' },
    high:      { label: 'Roads may be impassable',     cm: '15–30 cm' },
    very_high: { label: 'Building-level flooding risk', cm: '30–60+ cm' },
  }
  return map[level] || { label: 'Unknown', cm: 'N/A' }
}

function _mockRisk(lat: number, lng: number): number {
  if (40.735 < lat && lat < 40.760 && -74.042 < lng && lng < -74.025) return 0.68
  if (40.710 < lat && lat < 40.730 && -74.040 < lng && lng < -74.025) return 0.72
  if (lat < 40.710 && lng < -74.075) return 0.70
  if (40.760 < lat && lat < 40.790 && -74.090 < lng && lng < -74.055) return 0.58
  if (40.742 < lat && lat < 40.758 && -74.085 < lng && lng < -74.060) return 0.22
  return 0.35 + Math.abs(Math.sin(lat * 200 + lng * 100)) * 0.2
}
