# Flood Risk Tile Server — Setup Guide

## What it does
Reads `data_static/static_fv_10m.tif` (included in the repo) and serves:
- `GET /api/risk?lat=40.73&lng=-74.07` — flood risk score at any point
- `GET /api/tiles/{z}/{x}/{y}.png` — colored map tiles for the Leaflet overlay
- `GET /api/health` — server status check

## Setup (one time)

### 1. Install Python dependencies
```bash
cd flash-flood-project-eta/server
pip install -r requirements.txt
```

If `rasterio` install fails on Windows, use conda instead:
```bash
conda install -c conda-forge rasterio pyproj flask flask-cors pillow numpy
```

### 2. TIF path (no config needed)
The server automatically locates `data_static/static_fv_10m.tif` relative to the
project root — no environment variable required. If you want to override it:
```bash
# Windows CMD
set TIF_PATH=path\to\your.tif
python server.py

# Windows PowerShell
$env:TIF_PATH="path\to\your.tif"
python server.py
```

### 3. Run the server
```bash
cd flash-flood-project-eta/server
python server.py
```

You should see:
```
=======================================================
  Hudson County Flood Risk Tile Server
=======================================================
  TIF path : ...\data_static\static_fv_10m.tif
  TIF exists: True
  Rasterio : ✓
  Pillow   : ✓
  Mode     : LIVE GeoTIFF
=======================================================
```

### 4. Run the frontend (separate terminal)
```bash
cd flash-flood-project-eta
npm run dev
```

Open http://localhost:5173 — the app will automatically proxy `/api` calls to `localhost:5000`.

## Performance notes

The 1.09GB TIF is read with **windowed reads** — only the pixel under the cursor is read per click, not the whole file. Tile rendering samples a grid of points and may be slow for first loads at high zoom; this can be improved by building overviews in QGIS:

```
Raster → Miscellaneous → Build Overviews (Pyramids)
Levels: 2 4 8 16 32
Resampling: Average
```

## Offline / mock mode
If the server is offline, the app falls back to **estimated values** based on known Hudson County flood geography (Hoboken, JC waterfront, Bayonne, Secaucus). These are clearly labeled as "Estimated" in the UI.
