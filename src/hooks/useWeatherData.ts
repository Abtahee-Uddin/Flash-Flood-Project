import { useState, useEffect, useCallback, useRef } from 'react'
import { HUDSON_COUNTY_BBOX, computeRainFactor, computeWetnessFactor, TimeStep } from '../utils/floodRisk'

export interface WeatherData {
  currentRainfall: number        // mm/hr
  soilMoisture: number          // 0-1
  hourlyForecast: HourlyForecast[]
  lastUpdated: Date | null
  loading: boolean
  error: string | null
}

export interface HourlyForecast {
  time: Date
  rainfall: number
  rainFactor: number
  soilMoisture: number
  wetnessFactor: number
}

const LAT = (HUDSON_COUNTY_BBOX.north + HUDSON_COUNTY_BBOX.south) / 2
const LNG = (HUDSON_COUNTY_BBOX.east + HUDSON_COUNTY_BBOX.west) / 2

export function useWeatherData(refreshIntervalMs = 300000): WeatherData {
  const [data, setData] = useState<WeatherData>({
    currentRainfall: 0,
    soilMoisture: 0.3,
    hourlyForecast: [],
    lastUpdated: null,
    loading: true,
    error: null,
  })

  const mounted = useRef(true)

  const fetchWeather = useCallback(async () => {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?` +
        `latitude=${LAT}&longitude=${LNG}` +
        `&hourly=precipitation,soil_moisture_0_to_1cm` +
        `&current=precipitation` +
        `&forecast_days=1` +
        `&timezone=America%2FNew_York`

      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()

      const currentRainfall: number = json.current?.precipitation ?? 0
      
      // Build hourly forecast (next 12 hours)
      const hourlyTimes: string[] = json.hourly?.time ?? []
      const hourlyPrecip: number[] = json.hourly?.precipitation ?? []
      const hourlySoil: number[] = json.hourly?.soil_moisture_0_to_1cm ?? []

      const now = new Date()
      const currentHour = now.getHours()

      // Find current hour index
      const startIdx = Math.max(0, hourlyTimes.findIndex(t => {
        const d = new Date(t)
        return d.getHours() >= currentHour
      }))

      const hourlyForecast: HourlyForecast[] = []
      for (let i = startIdx; i < Math.min(startIdx + 12, hourlyTimes.length); i++) {
        const rainfall = hourlyPrecip[i] ?? 0
        const sm = hourlySoil[i] ?? 0.3
        hourlyForecast.push({
          time: new Date(hourlyTimes[i]),
          rainfall,
          rainFactor: computeRainFactor(rainfall),
          soilMoisture: sm,
          wetnessFactor: computeWetnessFactor(sm),
        })
      }

      const soilMoisture = hourlySoil[startIdx] ?? 0.3

      if (mounted.current) {
        setData({
          currentRainfall,
          soilMoisture,
          hourlyForecast,
          lastUpdated: new Date(),
          loading: false,
          error: null,
        })
      }
    } catch (err) {
      // Fallback to realistic simulated data if API fails
      if (mounted.current) {
        const simulated = generateSimulatedWeather()
        setData({
          ...simulated,
          loading: false,
          error: `Live data unavailable — using simulated data`,
        })
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    fetchWeather()
    const interval = setInterval(fetchWeather, refreshIntervalMs)
    return () => {
      mounted.current = false
      clearInterval(interval)
    }
  }, [fetchWeather, refreshIntervalMs])

  return data
}

function generateSimulatedWeather(): Omit<WeatherData, 'loading' | 'error'> {
  // Simulate a building storm scenario
  const baseRain = Math.random() * 15 + 2
  const soilMoisture = 0.25 + Math.random() * 0.2
  
  const hourlyForecast: HourlyForecast[] = []
  const now = new Date()
  
  for (let i = 0; i < 12; i++) {
    // Storm builds then dissipates
    const stormMultiplier = i < 3
      ? 1 + i * 0.8
      : i < 6
        ? 3.5 - (i - 3) * 0.4
        : Math.max(0.3, 2.0 - i * 0.15)
    
    const rainfall = baseRain * stormMultiplier * (0.8 + Math.random() * 0.4)
    const sm = soilMoisture + i * 0.02
    
    hourlyForecast.push({
      time: new Date(now.getTime() + i * 3600000),
      rainfall,
      rainFactor: computeRainFactor(rainfall),
      soilMoisture: sm,
      wetnessFactor: computeWetnessFactor(sm),
    })
  }

  return {
    currentRainfall: baseRain,
    soilMoisture,
    hourlyForecast,
    lastUpdated: new Date(),
  }
}

export function buildTimeSteps(forecast: HourlyForecast[]): TimeStep[] {
  return forecast.map(f => ({
    timestamp: f.time,
    rainfallMm: f.rainfall,
    soilMoisture: f.soilMoisture,
    rainFactor: f.rainFactor,
    wetnessFactor: f.wetnessFactor,
  }))
}
