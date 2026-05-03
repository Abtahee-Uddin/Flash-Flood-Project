import { useState, useEffect } from 'react'
import { useWeatherData } from './hooks/useWeatherData'
import { useFloodQuery } from './hooks/useFloodQuery'
import { useWatchlist } from './hooks/useWatchlist'
import Header from './components/Header'
import Sidebar from './components/Sidebar'
import MapView from './components/MapView'
import StatusBar from './components/StatusBar'
import SimpleView from './components/SimpleView'
import styles from './App.module.css'

export type MapMode = 'static' | 'dynamic' | 'forecast' | 'historical'
export type AppView = 'simple' | 'advanced'

export default function App() {
  const [appView, setAppView] = useState<AppView>('simple')
  const [mapMode, setMapMode] = useState<MapMode>('dynamic')
  const [scenario, setScenario] = useState('none')

  // Shared across both views
  const floodQuery = useFloodQuery()
  const watchlist = useWatchlist()
  const weather = useWeatherData(300000)

  // Keep floodQuery's internal mapMode in sync with app-level mapMode
  // Also refresh all watchlist points with the correct mode's risk values
  useEffect(() => {
    const effectiveMode = mapMode === 'static' && scenario !== 'none'
      ? `scenario:${scenario}`
      : mapMode
    floodQuery.setQueryMapMode(effectiveMode as any)
    watchlist.refreshAllRisk(effectiveMode)
  }, [mapMode, scenario])

  if (appView === 'simple') {
    return (
      <SimpleView
        weather={weather}
        onSwitchView={() => setAppView('advanced')}
        floodQuery={floodQuery}
        watchlist={watchlist}
        mapMode={mapMode}
        setMapMode={setMapMode}
      />
    )
  }

  return (
    <div className={styles.app}>
      <Header
        mapMode={mapMode}
        setMapMode={setMapMode}
        weather={weather}
        appView={appView}
        setAppView={setAppView}
        scenario={scenario}
        setScenario={setScenario}
      />
      <div className={styles.body}>
        <Sidebar
          watchlist={watchlist}
          floodQuery={floodQuery}
          weather={weather}
          mapMode={mapMode}
        />
        <div className={styles.mapContainer}>
          <MapView
            mapMode={mapMode}
            floodQuery={floodQuery}
            watchlist={watchlist}
            scenario={scenario}
          />
        </div>
      </div>
      <StatusBar weather={weather} watchlist={watchlist} />
    </div>
  )
}
