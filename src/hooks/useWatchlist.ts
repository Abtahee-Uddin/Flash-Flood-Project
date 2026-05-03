import { useState, useCallback } from 'react'

export interface WatchlistItem {
  id: string
  name: string           // user-given label
  address: string        // full address from geocoder
  lat: number
  lng: number
  alertEnabled: boolean
  // Risk snapshot (refreshed on demand)
  risk_score: number | null
  risk_level: string
  risk_pct: number | null
  depth_label: string
  depth_cm: string
  addedAt: number        // timestamp
  lastChecked: number | null
}

export interface UseWatchlistReturn {
  items: WatchlistItem[]
  addItem: (item: Omit<WatchlistItem, 'id' | 'addedAt' | 'lastChecked'>) => WatchlistItem
  removeItem: (id: string) => void
  updateItem: (id: string, updates: Partial<WatchlistItem>) => void
  toggleAlert: (id: string) => void
  clearAll: () => void
  exportJSON: () => void
  importJSON: (json: string) => boolean
  hasItem: (lat: number, lng: number) => boolean
  refreshAllRisk: (mode: string) => Promise<void>
}

function generateId(): string {
  return `wl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

export function useWatchlist(): UseWatchlistReturn {
  const [items, setItems] = useState<WatchlistItem[]>([])

  const addItem = useCallback((item: Omit<WatchlistItem, 'id' | 'addedAt' | 'lastChecked'>): WatchlistItem => {
    const newItem: WatchlistItem = {
      ...item,
      id: generateId(),
      addedAt: Date.now(),
      lastChecked: null,
    }
    setItems(prev => [newItem, ...prev])
    return newItem
  }, [])

  const removeItem = useCallback((id: string) => {
    setItems(prev => prev.filter(i => i.id !== id))
  }, [])

  const updateItem = useCallback((id: string, updates: Partial<WatchlistItem>) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...updates, lastChecked: Date.now() } : i))
  }, [])

  const toggleAlert = useCallback((id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, alertEnabled: !i.alertEnabled } : i))
  }, [])

  const clearAll = useCallback(() => setItems([]), [])

  const exportJSON = useCallback(() => {
    const data = JSON.stringify(items, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `flood-watchlist-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [items])

  const importJSON = useCallback((json: string): boolean => {
    try {
      const parsed = JSON.parse(json)
      if (!Array.isArray(parsed)) return false
      const valid = parsed.filter(i =>
        typeof i.lat === 'number' &&
        typeof i.lng === 'number' &&
        typeof i.name === 'string'
      ).map(i => ({
        ...i,
        id: generateId(), // new IDs to avoid conflicts
        addedAt: i.addedAt || Date.now(),
        lastChecked: null,
      }))
      setItems(prev => [...valid, ...prev])
      return true
    } catch {
      return false
    }
  }, [])

  const hasItem = useCallback((lat: number, lng: number): boolean => {
    return items.some(i => Math.abs(i.lat - lat) < 0.0001 && Math.abs(i.lng - lng) < 0.0001)
  }, [items])

  const refreshAllRisk = useCallback(async (mode: string) => {
    const isScenario = mode.startsWith('scenario:')
    const scenarioId = isScenario ? mode.replace('scenario:', '') : ''
    const endpoint = isScenario
      ? `/api/scenario/risk`
      : mode === 'forecast'   ? '/api/forecast/risk'
      : mode === 'historical' ? '/api/historical/risk'
      : mode === 'dynamic'    ? '/api/dynamic/risk'
                              : '/api/risk'
    // Capture items at call time, then fetch each one independently
    setItems(current => {
      const snapshot = [...current]
      // Schedule fetches outside the render cycle
      setTimeout(() => {
        snapshot.forEach(item => {
          fetch(endpoint + `?lat=${item.lat}&lng=${item.lng}` + (isScenario ? `&scenario=${scenarioId}` : ''))
            .then(r => r.ok ? r.json() : null)
            .then(data => {
              if (!data) return
              setItems(curr => curr.map(i => i.id === item.id ? {
                ...i,
                risk_score:  data.risk_score  ?? i.risk_score,
                risk_level:  data.risk_level  ?? i.risk_level,
                risk_pct:    data.risk_pct    ?? i.risk_pct,
                depth_label: data.depth?.label ?? i.depth_label,
                depth_cm:    data.depth?.cm    ?? i.depth_cm,
                lastChecked: Date.now(),
              } : i))
            })
            .catch(() => {})
        })
      }, 0)
      return current  // synchronous return unchanged
    })
  }, [])

  return { items, addItem, removeItem, updateItem, toggleAlert, clearAll, exportJSON, importJSON, hasItem, refreshAllRisk }
}
