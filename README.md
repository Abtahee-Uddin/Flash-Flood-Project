# Hudson County Flash Flood Intelligence System

A real-time flood risk monitoring and 48-hour forecast dashboard for Hudson County, NJ.

## Features

- **Static Mode** — pre-computed terrain/hydrology flood vulnerability raster (DEM, slope, flow accumulation, impervious surface, soil type)
- **Dynamic Mode** — live risk using current Open-Meteo rainfall + NASA POWER soil moisture
- **Forecast Mode** — 48-hour ahead risk via a 7-step pipeline (Open-Meteo forecast + NASA POWER soil moisture → hourly risk rasters → ETA + peak-risk maps → street-level stats)
- **Historical Mode** — replay of Hurricane Ida (2021-09-01) hindcast for comparison
- **Street & Building Overlays** — all 11,376 road segments and ~109,781 building footprints colored by flood risk
- **ETA System** — per-road-segment hour-to-critical-risk from forecast rasters
- **Watchlist** — save and monitor specific locations with optional high-risk alerts
- **Simple / Advanced views** — clean public-facing map vs. full operator dashboard

## Risk Model

```
Risk = StaticFV × RainFactor × SoilMoisture

Where:
  RainFactor    = rainfall_mm / 75.0   (75 mm/hr normalisation ceiling)
  SoilMoisture  = raster value 0.0–1.0 (NASA POWER / ERA5-Land)
  StaticFV      = static flood vulnerability pixel value 0.0–1.0

Street-level risk thresholds (max_risk along segment):
  ≥ 0.12  → Very High
  ≥ 0.09  → High
  ≥ 0.06  → Moderate
  ≥ 0.03  → Low
  < 0.03  → None

ETA threshold: first forecast hour where pixel risk ≥ 0.05
```

## Setup

### Backend (Python server)

```bash
cd server/
pip install flask flask-cors rasterio numpy pyproj pillow pandas geopandas
python server.py
```

Server runs on **http://localhost:5000**

### Frontend (Vite + React)

```bash
npm install
npm run dev
```

Open **http://localhost:5173** — Vite proxies `/api` → `localhost:5000`.

## Modes

| Mode | Data source | Requires pipeline? |
|------|-------------|--------------------|
| **Static** | `data_static/static_fv_10m.tif` | No |
| **Dynamic** | Open-Meteo live API + NASA POWER soil | No |
| **Forecast** | 48-hr Open-Meteo forecast + NASA POWER | Yes — run from Forecast panel |
| **Historical** | Hurricane Ida 2021-09-01 hindcast | Pre-generated; ships with repo |

## Architecture

```
flash-flood-project-eta/
├── server/
│   ├── server.py                        # Flask API (risk, tiles, roads, buildings, forecast)
│   ├── dynamic_core.py                  # 48-hr forecast pipeline orchestrator
│   ├── fetch_forecast_rainfall.py       # Step 2a — Open-Meteo 48-hr CSV download
│   ├── CSVtoRaster.py                   # Step 2b — CSV → rain_YYYYMMDD_HH.tif
│   ├── soil_moisture_hudson_county.py   # Step 3  — NASA POWER → wf_YYYYMMDD_HH.tif
│   ├── compute_eta.py                   # Step 5  — risk stack → eta.tif
│   ├── max_risk_from_stack.py           # Step 6  — risk stack → max_risk.tif
│   └── street_level_stats.py           # Step 7  — rasters + roads → street.geojson
├── src/
│   ├── components/
│   │   ├── SimpleView.tsx               # Default public-facing map interface
│   │   ├── MapView.tsx                  # Advanced operator dashboard
│   │   ├── DynamicPanel.tsx             # Dynamic Risk Engine status panel
│   │   ├── ForecastPanel.tsx            # 48-Hour Forecast Engine panel
│   │   ├── WatchlistPanel.tsx           # Saved locations + alerts
│   │   ├── RiskPopup.tsx                # Map-click popup
│   │   └── Sidebar.tsx / StatusBar.tsx  # Advanced-view sidebar & footer
│   └── App.tsx
├── public/
│   ├── hudson_roads.geojson             # 11,376 road segments (NJ 911 GIS, simplified)
│   ├── hudson_buildings.geojson         # ~109,781 building footprints
│   └── hudson_county.geojson            # County boundary
└── data_static/
    └── static_fv_10m.tif               # Static flood vulnerability raster (EPSG:26918)
```

## Forecast Pipeline (7 steps)

Triggered from the **Forecast panel** in the UI (`POST /api/forecast/run`). All previous outputs are deleted before each run.

```
Step 0   Cleanup       — delete all previous forecast outputs
Step 1   Static TIF    — verify data_static/static_fv_10m.tif is present
Step 2a  Rainfall CSV  — fetch_forecast_rainfall.py downloads 48-hr forecast from Open-Meteo
Step 2b  Rain rasters  — CSVtoRaster.py converts CSV → rain_YYYYMMDD_HH.tif (one per hour)
Step 3   Soil rasters  — soil_moisture_hudson_county.py --mode forecast
                          downloads NASA POWER data → wf_YYYYMMDD_HH.tif
Step 4   Risk rasters  — dynamic_core.py computes risk_YYYYMMDD_HH.tif for each hour
                          formula: risk = static × (rain / 75.0) × soil
Step 5   ETA           — compute_eta.py → eta.tif (first hour risk ≥ 0.05 per pixel)
Step 6   Max risk      — max_risk_from_stack.py → max_risk.tif (pixel-wise peak)
Step 7   Street stats  — street_level_stats.py samples rasters along road segments
                          → street.geojson (max_risk + eta_hour per segment)
```

Output locations:
- `server/data_dynamic_raw/rainfall/forecast/` — rain CSVs + rain rasters
- `server/data_dynamic_raw/soil/latest/` — soil moisture rasters
- `server/data_dynamic_processed/dynamic_risk/forecast/` — hourly risk rasters
- `server/` — `eta.tif`, `max_risk.tif`, `street.geojson`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server health check |
| GET | `/api/risk?lat=&lng=` | Static vulnerability at point |
| GET | `/api/dynamic/risk?lat=&lng=` | Live dynamic risk at point |
| GET | `/api/forecast/risk?lat=&lng=` | Forecast peak risk at point |
| GET | `/api/historical/risk?lat=&lng=` | Ida hindcast risk at point |
| GET | `/api/forecast/roads` | Roads colored by forecast risk |
| GET | `/api/historical/roads` | Roads colored by Ida risk |
| GET | `/api/forecast/buildings?west=&south=&east=&north=` | Building footprints (forecast) |
| GET | `/api/historical/buildings?…` | Building footprints (historical) |
| GET | `/api/forecast/status` | Pipeline status + file inventory |
| POST | `/api/forecast/run` | Trigger 48-hr forecast pipeline |
| GET | `/api/tiles/{z}/{x}/{y}.png` | Static TIF tile overlay |
| GET | `/api/dynamic/status` | Dynamic pipeline status |

## Data Sources

| Source | Data | Used by |
|--------|------|---------|
| `data_static/static_fv_10m.tif` | Flood vulnerability raster (EPSG:26918, 0.0–1.0) | All modes |
| [Open-Meteo](https://open-meteo.com) | 48-hr hourly precipitation forecast (mm) | Forecast pipeline |
| [Open-Meteo](https://open-meteo.com) | Current precipitation + soil moisture | Dynamic mode |
| [NASA POWER](https://power.larc.nasa.gov) | GWETPROF daily soil moisture | Forecast pipeline step 3 |
| `public/hudson_roads.geojson` | 11,376 road segments (NJ 911 GIS, simplified) | Road overlay |
| `public/hudson_buildings.geojson` | ~109,781 building footprints | Buildings overlay |
| OpenStreetMap / Nominatim | Address geocoding | Search bar |
| CartoDB Light | Base map tiles | All views |

## Known Flood-Prone Areas (Hudson County)

- **Hoboken** — historically below sea level; severe 2012 Sandy flooding
- **Jersey City Waterfront** — low elevation near Hudson River
- **Bayonne Peninsula** — surrounded by Newark Bay
- **Secaucus / Kearny** — former marshlands near Hackensack River
