// ============================================================
// HUDSON COUNTY FLOOD RISK MODEL
// Implements the Static + Dynamic workflow
// ============================================================

export interface LatLng { lat: number; lng: number }
export interface BoundingBox { north: number; south: number; east: number; west: number }

export const HUDSON_COUNTY_BBOX: BoundingBox = {
  north: 40.7920,
  south: 40.6850,
  east: -74.0200,
  west: -74.1300,
}

export type RiskLevel = 'none' | 'low' | 'moderate' | 'high' | 'very_high'

export interface AssetRisk {
  id: string
  name: string
  type: 'street' | 'building'
  lat: number
  lng: number
  staticFV: number         // 0-1 static flood vulnerability
  dynamicRisk: number      // 0-1 current dynamic risk
  riskLevel: RiskLevel
  etaMinutes: number | null
  rainfallMm: number
  soilMoisture: number
  impactCategory: string
  address?: string
}

export interface TimeStep {
  timestamp: Date
  rainfallMm: number    // mm/hr
  soilMoisture: number  // 0-1
  rainFactor: number    // normalized 0-1
  wetnessFactor: number // normalized 0-1
}

// ── Static Flood Vulnerability ───────────────────────────────
// Hudson County has real flood-prone areas:
// - Areas near the Hudson River waterfront (Jersey City, Hoboken)
// - Low-lying areas around Newark Bay (Bayonne, Kearny)
// - Areas near Hackensack River (North Bergen, Secaucus)
// - Urban areas with high impervious surface coverage
// This function computes a static score based on known geography.

export function computeStaticFV(lat: number, lng: number): number {
  // Low elevation near Hudson River (Jersey City waterfront, Hoboken)
  const hudsonProximity = Math.max(0, 1 - Math.abs(lng - (-74.038)) * 20)
  
  // Newark Bay / Bayonne peninsula
  const bayonneZone = lat < 40.710 && lng < -74.075 ? 0.85 : 0
  
  // Secaucus / Kearny marshlands near Hackensack
  const hackensackZone = (lat > 40.750 && lat < 40.790 && lng > -74.09 && lng < -74.06)
    ? 0.75 : 0
  
  // Journal Square / Greenville low-lying urban
  const urbanLow = (lat > 40.720 && lat < 40.745 && lng > -74.07 && lng < -74.045)
    ? 0.55 : 0
  
  // Hoboken - very flat, below sea level in some areas
  const hoboken = (lat > 40.735 && lat < 40.760 && lng > -74.042 && lng < -74.025)
    ? 0.80 : 0

  // Jersey City Heights (higher elevation - lower risk)
  const heights = (lat > 40.742 && lat < 40.758 && lng > -74.085 && lng < -74.060)
    ? -0.2 : 0

  const raw = Math.max(
    hudsonProximity * 0.6,
    bayonneZone,
    hackensackZone,
    urbanLow,
    hoboken
  ) + heights

  return Math.min(1, Math.max(0.05, raw + Math.random() * 0.08 - 0.04))
}

// ── Dynamic Risk (Step 5 formula) ───────────────────────────
// DynamicRisk(t) = StaticFV × (0.6 × RainFactor(t) + 0.4 × WetnessFactor(t))
export function computeDynamicRisk(
  staticFV: number,
  rainFactor: number,
  wetnessFactor: number
): number {
  const raw = staticFV * (0.6 * rainFactor + 0.4 * wetnessFactor)
  return Math.min(1, Math.max(0, raw))
}

export function computeRainFactor(rainfallMmPerHr: number, maxRain = 50): number {
  return Math.min(1, Math.max(0, rainfallMmPerHr / maxRain))
}

export function computeWetnessFactor(
  soilMoisture: number,
  minMoisture = 0.1,
  maxMoisture = 0.6
): number {
  return Math.min(1, Math.max(0, (soilMoisture - minMoisture) / (maxMoisture - minMoisture)))
}

export function getRiskLevel(score: number): RiskLevel {
  if (score < 0.2) return 'none'
  if (score < 0.4) return 'low'
  if (score < 0.6) return 'moderate'
  if (score < 0.8) return 'high'
  return 'very_high'
}

export function getRiskColor(level: RiskLevel): string {
  switch (level) {
    case 'none': return '#22c55e'
    case 'low': return '#84cc16'
    case 'moderate': return '#eab308'
    case 'high': return '#f97316'
    case 'very_high': return '#ef4444'
  }
}

export function getImpactCategory(level: RiskLevel): string {
  switch (level) {
    case 'none': return 'No impact expected'
    case 'low': return 'Minor ponding possible'
    case 'moderate': return 'Shallow street water'
    case 'high': return 'Vehicle hazard / road closure'
    case 'very_high': return 'Building risk / evacuation zone'
  }
}

export function computeETA(
  timeSteps: TimeStep[],
  staticFV: number,
  threshold = 0.6,
  intervalMinutes = 60
): number | null {
  for (let i = 0; i < timeSteps.length; i++) {
    const { rainFactor, wetnessFactor } = timeSteps[i]
    const risk = computeDynamicRisk(staticFV, rainFactor, wetnessFactor)
    if (risk >= threshold) return i * intervalMinutes
  }
  return null
}

// ── Hudson County Key Assets ──────────────────────────────────
// Real streets and neighborhoods for demo
export const HUDSON_COUNTY_ASSETS: Array<{
  id: string
  name: string
  type: 'street' | 'building'
  lat: number
  lng: number
  address?: string
}> = [
  // Major Streets - Jersey City
  { id: 'str-01', name: 'Marin Blvd', type: 'street', lat: 40.7178, lng: -74.0340, address: 'Jersey City Waterfront' },
  { id: 'str-02', name: 'Grand St', type: 'street', lat: 40.7145, lng: -74.0420 },
  { id: 'str-03', name: 'Newark Ave', type: 'street', lat: 40.7265, lng: -74.0495 },
  { id: 'str-04', name: 'Montgomery St', type: 'street', lat: 40.7185, lng: -74.0445 },
  { id: 'str-05', name: 'Communipaw Ave', type: 'street', lat: 40.7080, lng: -74.0680 },
  { id: 'str-06', name: 'Tonnele Ave', type: 'street', lat: 40.7380, lng: -74.0705 },
  { id: 'str-07', name: 'Bergenline Ave', type: 'street', lat: 40.7680, lng: -74.0275 },
  // Hoboken
  { id: 'str-08', name: 'Washington St (Hoboken)', type: 'street', lat: 40.7448, lng: -74.0290 },
  { id: 'str-09', name: 'Observer Hwy', type: 'street', lat: 40.7378, lng: -74.0285 },
  { id: 'str-10', name: 'Sinatra Dr', type: 'street', lat: 40.7488, lng: -74.0200 },
  // Bayonne
  { id: 'str-11', name: 'Broadway (Bayonne)', type: 'street', lat: 40.6985, lng: -74.1075 },
  { id: 'str-12', name: 'Avenue C', type: 'street', lat: 40.6880, lng: -74.1035 },
  // Secaucus
  { id: 'str-13', name: 'County Ave', type: 'street', lat: 40.7795, lng: -74.0565 },
  { id: 'str-14', name: 'Paterson Plank Rd', type: 'street', lat: 40.7680, lng: -74.0620 },
  // Weehawken
  { id: 'str-15', name: 'Park Ave (Weehawken)', type: 'street', lat: 40.7635, lng: -74.0212 },

  // Key Buildings / Infrastructure
  { id: 'bld-01', name: 'Jersey City Medical Center', type: 'building', lat: 40.7175, lng: -74.0508, address: '355 Grand St, Jersey City' },
  { id: 'bld-02', name: 'Newport Centre Mall', type: 'building', lat: 40.7258, lng: -74.0338, address: 'Jersey City Waterfront' },
  { id: 'bld-03', name: 'Hoboken Terminal', type: 'building', lat: 40.7356, lng: -74.0247, address: '1 Hudson Pl, Hoboken' },
  { id: 'bld-04', name: 'Exchange Place PATH', type: 'building', lat: 40.7163, lng: -74.0325, address: 'Exchange Pl, Jersey City' },
  { id: 'bld-05', name: 'Bayonne Bridge', type: 'building', lat: 40.6488, lng: -74.1423, address: 'Bayonne / Staten Island' },
  { id: 'bld-06', name: 'Secaucus Junction', type: 'building', lat: 40.7613, lng: -74.0568, address: 'Secaucus, NJ' },
  { id: 'bld-07', name: 'Liberty State Park Visitor Center', type: 'building', lat: 40.7040, lng: -74.0582, address: 'Jersey City' },
  { id: 'bld-08', name: 'Hudson County Courthouse', type: 'building', lat: 40.7270, lng: -74.0455, address: '595 Newark Ave, Jersey City' },
  { id: 'bld-09', name: 'Harborside Financial Center', type: 'building', lat: 40.7180, lng: -74.0320, address: 'Jersey City' },
  { id: 'bld-10', name: 'Kearny High School', type: 'building', lat: 40.7650, lng: -74.1025, address: 'Kearny, NJ' },
]
