import { useRef, useEffect } from 'react'
import { Search, X, Loader, MapPin, Navigation } from 'lucide-react'
import { UseFloodQueryReturn } from '../hooks/useFloodQuery'
import styles from './MapSearch.module.css'

interface Props {
  query: UseFloodQueryReturn
  onSelectLocation: (lat: number, lng: number, address: string) => void
  placeholder?: string
  variant?: 'simple' | 'advanced'
}

export default function MapSearch({ query, onSelectLocation, placeholder = 'Search address or place in Hudson County...', variant = 'simple' }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        query.clearSearch()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [query])

  const handleInput = (val: string) => {
    query.setSearchQuery(val)
    query.fetchSuggestions(val)
  }

  const handleSelect = (sug: { display_name: string; lat: string; lon: string }) => {
    const lat = parseFloat(sug.lat)
    const lng = parseFloat(sug.lon)
    // Format a clean address label
    const label = sug.display_name.split(',').slice(0, 3).join(', ')
    query.setSearchQuery(label)
    query.clearSearch()  // close dropdown
    onSelectLocation(lat, lng, sug.display_name)
  }

  const handleCurrentLocation = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: lat, longitude: lng } = pos.coords
        onSelectLocation(lat, lng, 'Your Location')
        query.setSearchQuery('Your Location')
      },
      () => {},
      { timeout: 8000 }
    )
  }

  const isOpen = query.suggestions.length > 0 && query.searchQuery.length >= 3

  return (
    <div
      ref={containerRef}
      className={`${styles.container} ${styles[variant]}`}
    >
      <div className={styles.inputRow}>
        {query.searchLoading
          ? <Loader size={16} className={styles.spinIcon} />
          : <Search size={16} className={styles.searchIcon} />
        }
        <input
          ref={inputRef}
          className={styles.input}
          value={query.searchQuery}
          onChange={e => handleInput(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.inputActions}>
          {query.searchQuery && (
            <button
              className={styles.clearBtn}
              onClick={() => { query.setSearchQuery(''); query.clearSearch() }}
              title="Clear"
            >
              <X size={14} />
            </button>
          )}
          <button
            className={styles.locationBtn}
            onClick={handleCurrentLocation}
            title="Use my location"
          >
            <Navigation size={14} />
          </button>
        </div>
      </div>

      {/* Suggestions dropdown */}
      {isOpen && (
        <div className={styles.dropdown}>
          {query.suggestions.map((sug, i) => {
            const parts = sug.display_name.split(', ')
            const primary = parts.slice(0, 2).join(', ')
            const secondary = parts.slice(2, 5).join(', ')
            const typeIcon = sug.type === 'road' || sug.type === 'residential'
              ? '⎔'
              : sug.type === 'house' || sug.type === 'building'
                ? '▣'
                : '◎'
            return (
              <button key={i} className={styles.suggestion} onClick={() => handleSelect(sug)}>
                <span className={styles.sugIcon}>{typeIcon}</span>
                <div className={styles.sugText}>
                  <div className={styles.sugPrimary}>{primary}</div>
                  <div className={styles.sugSecondary}>{secondary}</div>
                </div>
                <MapPin size={12} className={styles.sugArrow} />
              </button>
            )
          })}
          {query.searchError && (
            <div className={styles.sugError}>{query.searchError}</div>
          )}
        </div>
      )}

      {/* No results message */}
      {!isOpen && query.searchQuery.length >= 3 && !query.searchLoading && query.suggestions.length === 0 && (
        <div className={styles.dropdown}>
          <div className={styles.sugEmpty}>No results for "{query.searchQuery}"</div>
        </div>
      )}
    </div>
  )
}
