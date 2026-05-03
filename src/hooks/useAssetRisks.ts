import { useMemo, useState, useEffect } from 'react'
import {
  HUDSON_COUNTY_ASSETS,
  AssetRisk,
  computeStaticFV,
  computeDynamicRisk,
  computeRainFactor,
  computeWetnessFactor,
  computeETA,
  getRiskLevel,
  getImpactCategory,
} from '../utils/floodRisk'
import { WeatherData, buildTimeSteps } from './useWeatherData'

// Pre-compute static FV values (deterministic)
const staticFVMap: Record<string, number> = {}
HUDSON_COUNTY_ASSETS.forEach(asset => {
  staticFVMap[asset.id] = computeStaticFV(asset.lat, asset.lng)
})

export function useAssetRisks(weather: WeatherData): AssetRisk[] {
  const [tick, setTick] = useState(0)

  // Recompute every 30s for live feel even without weather updates
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30000)
    return () => clearInterval(interval)
  }, [])

  return useMemo(() => {
    const timeSteps = buildTimeSteps(weather.hourlyForecast)
    const rainFactor = computeRainFactor(weather.currentRainfall)
    const wetnessFactor = computeWetnessFactor(weather.soilMoisture)

    return HUDSON_COUNTY_ASSETS.map(asset => {
      const staticFV = staticFVMap[asset.id]
      const dynamicRisk = computeDynamicRisk(staticFV, rainFactor, wetnessFactor)
      const riskLevel = getRiskLevel(dynamicRisk)
      const etaMinutes = computeETA(timeSteps, staticFV, 0.6)

      return {
        ...asset,
        staticFV,
        dynamicRisk,
        riskLevel,
        etaMinutes,
        rainfallMm: weather.currentRainfall,
        soilMoisture: weather.soilMoisture,
        impactCategory: getImpactCategory(riskLevel),
      }
    })
  }, [weather.currentRainfall, weather.soilMoisture, weather.hourlyForecast, tick])
}
