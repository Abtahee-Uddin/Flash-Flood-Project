"""
dynamic_core.py — Flood risk computation engine
Integrates with server.py for the Hudson County Flash Flood Intelligence System.

Directory layout expected at FLOOD_PROJECT_ROOT:
  data_static/
      static_flood_vulnerability.tif   (or static_fv_10m.tif — whichever exists)
  data_dynamic_raw/
      rainfall/
          forecast/   forecast_YYYYMMDD_HH.csv
          historical/ YYYY-MM-DD/ rain_hourly.csv + rain_*.tif
      soil/
          latest/     soil_latest_*_resampled.tif
          historical/ YYYY-MM-DD/resampled/ wf_*.tif
  data_dynamic_processed/
      dynamic_risk/
          forecast/   risk_YYYYMMDD_HH.tif
          YYYY-MM-DD/ risk_YYYYMMDD_HH.tif
"""

import os
import glob
import datetime
import numpy as np

# ── Lazy imports (rasterio/pandas may not be installed) ──────────
try:
    import rasterio
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False

try:
    import pandas as pd
    HAS_PANDAS = True
except ImportError:
    HAS_PANDAS = False


_pandas_warn_printed = False

def _ensure_pandas():
    global pd, HAS_PANDAS, _pandas_warn_printed
    if not HAS_PANDAS:
        # Try adding common conda/pip site-packages paths before retrying
        import sys, os as _os
        _conda_paths = [
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'Lib', 'site-packages'),
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'lib', 'python3.11', 'site-packages'),
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'lib', 'python3.10', 'site-packages'),
        ]
        for p in _conda_paths:
            if p and _os.path.isdir(p) and p not in sys.path:
                sys.path.insert(0, p)
        try:
            import pandas as _pd
            pd = _pd
            HAS_PANDAS = True
            _pandas_warn_printed = False
            print(f"  [dynamic_core] pandas loaded from: {_pd.__file__}")
        except ImportError as e:
            if not _pandas_warn_printed:
                print(f"  [dynamic_core] pandas not found: {e}")
                print(f"  [dynamic_core] Fix: run 'python -m pip install pandas' in the same terminal as server.py")
                _pandas_warn_printed = True
    return HAS_PANDAS


def _ensure_rasterio():
    global rasterio, HAS_RASTERIO
    if not HAS_RASTERIO:
        import sys, os as _os
        _conda_paths = [
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'Lib', 'site-packages'),
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'lib', 'python3.11', 'site-packages'),
            _os.path.join(_os.environ.get('CONDA_PREFIX', ''), 'lib', 'python3.10', 'site-packages'),
        ]
        for p in _conda_paths:
            if p and _os.path.isdir(p) and p not in sys.path:
                sys.path.insert(0, p)
        try:
            import rasterio as _r
            rasterio = _r
            HAS_RASTERIO = True
            print(f"  [dynamic_core] rasterio loaded")
        except ImportError as e:
            print(f"  [dynamic_core] rasterio still not found: {e}")
    return HAS_RASTERIO

# ── Project root — parent directory of this server/ folder ──────────
# Works regardless of where the project is cloned or installed.
FLOOD_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Static TIF — prefer static_fv_10m.tif (shipped with the repo) ───
def _find_static_tif():
    candidates = [
        os.path.join(FLOOD_PROJECT_ROOT, "data_static", "static_fv_10m.tif"),
        os.path.join(FLOOD_PROJECT_ROOT, "data_static", "static_flood_vulnerability.tif"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    return candidates[0]  # return preferred path even if missing (error surfaces later)

STATIC_TIF = _find_static_tif()
MAX_RAIN   = 75.0  # mm/hr normalisation ceiling

# ── Helpers ───────────────────────────────────────────────────────
def _abs(rel):
    """Resolve a path relative to FLOOD_PROJECT_ROOT."""
    return os.path.join(FLOOD_PROJECT_ROOT, rel)

def load_raster(path):
    with rasterio.open(path) as src:
        return src.read(1), src.profile

def save_raster(data, profile, out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data.astype(np.float32), 1)


# ── Forecast pipeline ─────────────────────────────────────────────
def fetch_forecast_rainfall():
    """Download 48-hour precipitation forecast from Open-Meteo using stdlib urllib."""
    if not _ensure_pandas():
        raise RuntimeError("pandas not installed — pip install pandas")
    import urllib.request, urllib.parse, json as _json

    params = urllib.parse.urlencode({
        "latitude": 40.73, "longitude": -74.08,
        "hourly": "precipitation",
        "forecast_days": 2, "timezone": "UTC",
    })
    url = f"https://api.open-meteo.com/v1/forecast?{params}"
    with urllib.request.urlopen(url, timeout=15) as resp:
        data = _json.loads(resp.read())

    df = pd.DataFrame({
        "time":      data["hourly"]["time"],
        "precip_mm": data["hourly"]["precipitation"],
    })
    df["time"] = pd.to_datetime(df["time"])

    folder = _abs("data_dynamic_raw/rainfall/forecast")
    os.makedirs(folder, exist_ok=True)
    now      = datetime.datetime.utcnow().strftime("%Y%m%d_%H")
    csv_path = os.path.join(folder, f"forecast_{now}.csv")
    df.to_csv(csv_path, index=False)
    print(f"  [pipeline] Rainfall CSV saved: {csv_path}")
    return csv_path


def fetch_latest_soil():
    """Fetch today's soil moisture from NASA POWER and write spatial raster."""
    if not HAS_RASTERIO:
        raise RuntimeError("rasterio not installed")
    import urllib.request, urllib.parse, json as _json

    today    = datetime.datetime.now()
    date_str = today.strftime("%Y-%m-%d")

    params = urllib.parse.urlencode({
        "request": "execute", "format": "JSON", "user": "anonymous",
        "startDate": date_str, "endDate": date_str,
        "latitude": 40.73, "longitude": -74.08,
        "parameters": "GWETPROF",
    })
    base_value = 0.40  # fallback
    try:
        url = f"https://power.larc.nasa.gov/api/temporal/daily/point?{params}"
        with urllib.request.urlopen(url, timeout=20) as resp:
            d = _json.loads(resp.read())
        if "properties" in d:
            base_value = d["properties"]["parameter"]["GWETPROF"][date_str]
        print(f"  [pipeline] Soil moisture from NASA POWER: {base_value:.3f}")
    except Exception as e:
        m = today.month
        base_value = 0.45 if m in (3,4,5) else 0.35 if m in (6,7,8) else 0.42 if m in (9,10,11) else 0.38
        print(f"  [pipeline] NASA POWER unavailable ({e}), using seasonal fallback: {base_value}")

    # Build spatial raster matching the static TIF
    with rasterio.open(STATIC_TIF) as src:
        profile    = src.profile
        static     = src.read(1)
        nodata     = src.nodata
        bounds     = src.bounds
        width, height = src.width, src.height

    valid_mask = static != nodata

    x = np.linspace(bounds.left, bounds.right, width)
    y = np.linspace(bounds.bottom, bounds.top, height)
    X, Y = np.meshgrid(x, y)

    # Spatial variation: river proximity + urban drainage + micro-topo
    river_x, river_y = 577000, 4509000
    dist = np.sqrt(((X - river_x) / 1000)**2 + ((Y - river_y) / 1000)**2)
    river_effect = 0.10 * np.exp(-dist / 3)

    urban_centers = [(583000, 4505000), (576000, 4507000), (572000, 4512000)]
    urban_effect  = np.zeros_like(X)
    for ux, uy in urban_centers:
        d = np.sqrt(((X - ux) / 1000)**2 + ((Y - uy) / 1000)**2)
        urban_effect += -0.04 * np.exp(-d / 2)

    topo_effect = 0.02 * np.sin(X / 3000) * np.cos(Y / 3000)

    np.random.seed(int(today.hour))
    noise = 0.01 * np.random.randn(height, width)

    soil = base_value + river_effect + urban_effect + topo_effect + noise
    soil = np.clip(soil, 0.15, 0.70)
    soil[~valid_mask] = nodata

    folder = _abs("data_dynamic_raw/soil/latest")
    os.makedirs(folder, exist_ok=True)
    ts   = today.strftime("%Y%m%d_%H")
    path = os.path.join(folder, f"soil_latest_{ts}_resampled.tif")
    profile.update(dtype="float32")
    save_raster(soil, profile, path)
    return path, base_value


def hindcast_mode(event_date, soil_factor=None):
    """
    Hindcast pipeline for a historical event (e.g. Hurricane Ida 2021-09-01).
    Formula: risk = static * (rain / MAX_RAIN) * soil
    Inputs:
      - data_static/static_fv_10m.tif
      - data_dynamic_raw/rainfall/historical/{event_date}/rain_*.tif
      - data_dynamic_raw/soil/historical/{event_date}/resampled/wf_*.tif
    Output: data_dynamic_processed/dynamic_risk/{event_date}/risk_*.tif
    """
    _ensure_rasterio()
    _ensure_pandas()

    static, profile = load_raster(STATIC_TIF)
    static_nodata = profile.get('nodata', -3.4028235e+38)
    valid_mask = (static != static_nodata)
    profile.update(dtype='float32')

    rain_folder = _abs(f'data_dynamic_raw/rainfall/historical/{event_date}/')
    out_folder  = _abs(f'data_dynamic_processed/dynamic_risk/{event_date}/')
    os.makedirs(out_folder, exist_ok=True)

    rain_files = sorted(glob.glob(os.path.join(rain_folder, 'rain_*.tif')))
    if not rain_files:
        print(f'  [hindcast] No rainfall rasters found in {rain_folder}')
        return []

    use_constant_soil = soil_factor is not None
    if use_constant_soil:
        print(f'  [hindcast] Using constant soil factor = {soil_factor}')
        constant_soil = soil_factor
        soil_dict = {}
    else:
        soil_folder = _abs(f'data_dynamic_raw/soil/historical/{event_date}/resampled/')
        soil_files  = sorted(glob.glob(os.path.join(soil_folder, 'wf_*.tif')))
        soil_dict   = {}
        for sf in soil_files:
            fname   = os.path.basename(sf)
            ts_part = fname.replace('wf_', '').replace('.tif', '')
            soil_dict[ts_part] = sf
        print(f'  [hindcast] Found {len(soil_dict)} soil rasters')

    out_paths = []
    for rf in rain_files:
        basename = os.path.basename(rf)
        ts = basename.replace('rain_', '').replace('.tif', '')
        rain, _ = load_raster(rf)
        rain_factor = rain / MAX_RAIN
        risk = np.full_like(static, static_nodata, dtype=np.float32)

        if use_constant_soil:
            risk[valid_mask] = static[valid_mask] * rain_factor[valid_mask] * constant_soil
        else:
            if ts not in soil_dict:
                print(f'  [hindcast] Warning: No soil for {ts}, skipping')
                continue
            soil, _ = load_raster(soil_dict[ts])
            risk[valid_mask] = static[valid_mask] * rain_factor[valid_mask] * soil[valid_mask]

        out_path = os.path.join(out_folder, f'risk_{ts}.tif')
        save_raster(risk, profile, out_path)
        print(f'  [hindcast] Saved {out_path}')
        out_paths.append(out_path)

    return out_paths


def run_hindcast_pipeline(event_date='2021-09-01', soil_factor=None, threshold=0.05):
    """
    Full hindcast pipeline for a historical event:
      1. Run hourly risk rasters via hindcast_mode()
      2. Compute ETA raster (eta_ida.tif)
      3. Compute max-risk raster (max_risk_ida.tif)
      4. Generate street-level stats GeoJSON (street_ida.geojson)
    Returns dict with status and output paths.
    """
    result = {'ok': True, 'event_date': event_date, 'steps': {}}

    # Step 1 — risk rasters
    try:
        risk_paths = hindcast_mode(event_date, soil_factor=soil_factor)
        result['steps']['risk_rasters'] = len(risk_paths)
        if not risk_paths:
            return {'ok': False, 'error': 'No risk rasters produced — check rainfall/soil inputs'}
        risk_folder = os.path.dirname(risk_paths[0])
        result['steps']['risk_folder'] = risk_folder
    except Exception as e:
        return {'ok': False, 'error': f'Hindcast risk computation failed: {e}'}

    # Step 2 — ETA raster
    try:
        eta_path = _abs(f'data_dynamic_processed/dynamic_risk/{event_date}/eta_ida.tif')
        _compute_eta(risk_folder, eta_path, threshold=threshold, pattern='risk_*.tif')
        result['steps']['eta'] = eta_path
    except Exception as e:
        result['steps']['eta_error'] = str(e)

    # Step 3 — max-risk raster
    try:
        max_path = _abs(f'data_dynamic_processed/dynamic_risk/{event_date}/max_risk_ida.tif')
        _compute_max_risk(risk_folder, max_path, pattern='risk_*.tif')
        result['steps']['max_risk'] = max_path
    except Exception as e:
        result['steps']['max_risk_error'] = str(e)

    result['completed_at'] = datetime.datetime.utcnow().isoformat()
    return result


def _cleanup_forecast_outputs():
    """Delete all files generated by a previous forecast pipeline run."""
    import glob as _glob

    folders_and_patterns = [
        (_abs("data_dynamic_raw/rainfall/forecast"),   "rain_*.tif"),
        (_abs("data_dynamic_raw/rainfall/forecast"),   "forecast_*.tif"),   # old-style
        (_abs("data_dynamic_raw/soil/latest"),         "wf_*.tif"),
        (_abs("data_dynamic_processed/dynamic_risk/forecast"), "risk_*.tif"),
    ]
    removed = 0
    for folder, pattern in folders_and_patterns:
        for f in _glob.glob(os.path.join(folder, pattern)):
            try:
                os.remove(f)
                removed += 1
            except OSError:
                pass

    # Fixed output files in the server directory
    server_dir = os.path.dirname(os.path.abspath(__file__))
    for fname in ("eta.tif", "max_risk.tif", "street.geojson"):
        p = os.path.join(server_dir, fname)
        if os.path.exists(p):
            try:
                os.remove(p)
                removed += 1
            except OSError:
                pass

    print(f"  [cleanup] Removed {removed} files from previous forecast run.")


def _run_script(python, script_path, args=None, cwd=None):
    """
    Run a Python script as a subprocess.
    Returns (returncode, stdout, stderr).
    cwd defaults to the project root so relative-path scripts work correctly.
    """
    import subprocess as _sp
    cmd = [python, script_path] + (args or [])
    result = _sp.run(cmd, cwd=cwd or FLOOD_PROJECT_ROOT,
                     capture_output=True, text=True)
    if result.stdout:
        print(result.stdout, end='')
    if result.stderr:
        print(result.stderr, end='')
    return result.returncode, result.stdout, result.stderr


def run_forecast_pipeline():
    """
    Full 7-step forecast pipeline — calls the existing server scripts in order:
      Step 1 – static_fv_10m.tif (verified present)
      Step 2 – fetch_forecast_rainfall.py → CSVtoRaster.py
               → rain_YYYYMMDD_HH.tif in data_dynamic_raw/rainfall/forecast/
      Step 3 – soil_moisture_hudson_county.py --mode forecast
               → wf_YYYYMMDD_HH.tif in data_dynamic_raw/soil/latest/
      Step 4 – dynamic_core (this module) computes risk rasters
               → risk_YYYYMMDD_HH.tif in data_dynamic_processed/dynamic_risk/forecast/
               formula: risk = static * (rain / MAX_RAIN) * soil
      Step 5 – compute_eta.py --risk_folder … --threshold 0.05 --out eta.tif
      Step 6 – max_risk_from_stack.py --risk_folder … --out max_risk.tif
      Step 7 – street_level_stats.py --eta eta.tif --max_risk max_risk.tif --out street.geojson
    Cleans up all previous outputs before starting.
    Returns a status dict.
    """
    import sys as _sys

    _ensure_pandas()
    _ensure_rasterio()
    missing = []
    if not HAS_RASTERIO: missing.append("rasterio")
    if not HAS_PANDAS:   missing.append("pandas")
    if missing:
        return {"ok": False, "error": "Missing: " + ", ".join(missing) +
                " — run: pip install " + " ".join(missing)}

    result     = {"ok": True, "steps": {}}
    server_dir = os.path.dirname(os.path.abspath(__file__))
    python     = _sys.executable

    # ── Step 0: cleanup ───────────────────────────────────────────
    print("[forecast pipeline] Step 0: cleaning up previous outputs…")
    _cleanup_forecast_outputs()

    # ── Step 1: verify static TIF ─────────────────────────────────
    print("[forecast pipeline] Step 1: static vulnerability TIF…")
    if not os.path.exists(STATIC_TIF):
        return {"ok": False, "error": f"Static TIF not found: {STATIC_TIF}"}
    result["steps"]["static_tif"] = os.path.basename(STATIC_TIF)

    # ── Step 2a: fetch_forecast_rainfall.py ──────────────────────
    print("[forecast pipeline] Step 2a: fetching rainfall CSV (fetch_forecast_rainfall.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "fetch_forecast_rainfall.py"),
                               cwd=FLOOD_PROJECT_ROOT)
    if rc != 0:
        return {"ok": False, "error": f"fetch_forecast_rainfall.py failed (exit {rc}): {err.strip()}"}

    # Find the CSV that was just written
    rain_folder = _abs("data_dynamic_raw/rainfall/forecast")
    csv_files   = sorted(glob.glob(os.path.join(rain_folder, "forecast_*.csv")))
    if not csv_files:
        return {"ok": False, "error": "Step 2a: no forecast CSV found after fetch_forecast_rainfall.py"}
    result["steps"]["rainfall_csv"] = os.path.basename(csv_files[-1])

    # ── Step 2b: CSVtoRaster.py ──────────────────────────────────
    print("[forecast pipeline] Step 2b: converting CSV to rasters (CSVtoRaster.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "CSVtoRaster.py"),
                               cwd=FLOOD_PROJECT_ROOT)
    if rc != 0:
        return {"ok": False, "error": f"CSVtoRaster.py failed (exit {rc}): {err.strip()}"}

    rain_tifs = sorted(glob.glob(os.path.join(rain_folder, "rain_*.tif")))
    if not rain_tifs:
        return {"ok": False, "error": "Step 2b: no rain rasters found after CSVtoRaster.py"}
    result["steps"]["rain_rasters"] = len(rain_tifs)

    # ── Step 3: soil_moisture_hudson_county.py --mode forecast ───
    print("[forecast pipeline] Step 3: generating soil-moisture rasters (soil_moisture_hudson_county.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "soil_moisture_hudson_county.py"),
                               args=["--mode", "forecast"],
                               cwd=FLOOD_PROJECT_ROOT)
    if rc != 0:
        return {"ok": False, "error": f"soil_moisture_hudson_county.py failed (exit {rc}): {err.strip()}"}

    soil_folder = _abs("data_dynamic_raw/soil/latest")
    soil_tifs   = sorted(glob.glob(os.path.join(soil_folder, "wf_*.tif")))
    if not soil_tifs:
        return {"ok": False, "error": "Step 3: no soil rasters found after soil_moisture_hudson_county.py"}
    result["steps"]["soil_rasters"] = len(soil_tifs)

    # ── Step 4: dynamic_core risk computation ─────────────────────
    # dynamic_core IS step 4 — risk = static * (rain / MAX_RAIN) * soil
    print("[forecast pipeline] Step 4: computing risk rasters (dynamic_core)…")
    try:
        rain_ts_map = {}
        for p in rain_tifs:
            ts = os.path.basename(p)[len("rain_"):-len(".tif")]
            rain_ts_map[ts] = p
        soil_ts_map = {}
        for p in soil_tifs:
            ts = os.path.basename(p)[len("wf_"):-len(".tif")]
            soil_ts_map[ts] = p
        ordered_ts = sorted(rain_ts_map.keys())

        risk_paths = _compute_forecast_risk_from_rasters(ordered_ts, rain_ts_map, soil_ts_map)
        result["steps"]["risk_rasters"] = len(risk_paths)
    except Exception as e:
        return {"ok": False, "error": f"Step 4 (risk computation) failed: {e}"}

    if not risk_paths:
        return {"ok": False, "error": "Step 4: no risk rasters produced"}

    risk_folder = _abs("data_dynamic_processed/dynamic_risk/forecast")
    eta_path      = os.path.join(server_dir, "eta.tif")
    max_risk_path = os.path.join(server_dir, "max_risk.tif")
    street_path   = os.path.join(server_dir, "street.geojson")

    # ── Step 5: compute_eta.py ────────────────────────────────────
    print("[forecast pipeline] Step 5: computing ETA raster (compute_eta.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "compute_eta.py"),
                               args=["--risk_folder", risk_folder,
                                     "--threshold", "0.05",
                                     "--out", eta_path])
    if rc != 0:
        result["steps"]["eta_error"] = f"compute_eta.py failed (exit {rc}): {err.strip()}"
    else:
        result["steps"]["eta"] = os.path.basename(eta_path)

    # ── Step 6: max_risk_from_stack.py ───────────────────────────
    print("[forecast pipeline] Step 6: computing max-risk raster (max_risk_from_stack.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "max_risk_from_stack.py"),
                               args=["--risk_folder", risk_folder,
                                     "--out", max_risk_path])
    if rc != 0:
        result["steps"]["max_risk_error"] = f"max_risk_from_stack.py failed (exit {rc}): {err.strip()}"
    else:
        result["steps"]["max_risk"] = os.path.basename(max_risk_path)

    # ── Step 7: street_level_stats.py ────────────────────────────
    print("[forecast pipeline] Step 7: street-level aggregation (street_level_stats.py)…")
    rc, out, err = _run_script(python,
                               os.path.join(server_dir, "street_level_stats.py"),
                               args=["--eta",      eta_path,
                                     "--max_risk", max_risk_path,
                                     "--out",      street_path])
    if rc != 0:
        result["steps"]["street_error"] = f"street_level_stats.py failed (exit {rc}): {err.strip()}"
    else:
        result["steps"]["street_geojson"] = os.path.basename(street_path)

    result["completed_at"] = datetime.datetime.utcnow().isoformat()
    return result


def _compute_forecast_risk_from_rasters(ordered_ts, rain_ts_map, soil_ts_map):
    """
    For each timestamp, compute risk = static * (rain / MAX_RAIN) * soil.
    Outputs risk_YYYYMMDD_HH.tif into data_dynamic_processed/dynamic_risk/forecast/.
    """
    static, profile = load_raster(STATIC_TIF)
    nodata     = profile.get("nodata", -3.4028235e+38)
    valid_mask = (static != nodata)
    profile.update(dtype="float32")

    out_folder = _abs("data_dynamic_processed/dynamic_risk/forecast")
    os.makedirs(out_folder, exist_ok=True)

    paths = []
    skipped = 0
    for ts in ordered_ts:
        rain_path = rain_ts_map.get(ts)
        soil_path = soil_ts_map.get(ts)

        if not rain_path or not soil_path:
            skipped += 1
            continue

        rain_data, _ = load_raster(rain_path)
        soil_data, _ = load_raster(soil_path)

        risk = np.full_like(static, nodata, dtype=np.float32)
        risk[valid_mask] = (
            static[valid_mask] *
            (rain_data[valid_mask] / MAX_RAIN) *
            soil_data[valid_mask]
        )

        out_path = os.path.join(out_folder, f"risk_{ts}.tif")
        save_raster(risk, profile, out_path)
        paths.append(out_path)

    print(f"  [step 4] {len(paths)} risk rasters written ({skipped} skipped — no soil match)")
    return paths


def _compute_max_risk(risk_folder, out_file, pattern=None):
    if pattern:
        files = sorted(glob.glob(os.path.join(risk_folder, pattern)))
    else:
        files = sorted(glob.glob(os.path.join(risk_folder, "*.tif")))
    files = [f for f in files if "max_risk" not in f and "eta" not in f]
    if not files:
        return
    with rasterio.open(files[0]) as src:
        profile  = src.profile
        max_data = src.read(1).copy()
        nodata   = src.nodata
    for f in files[1:]:
        with rasterio.open(f) as src:
            data = src.read(1)
            mask = (data != nodata) & (data > max_data)
            max_data[mask] = data[mask]
    with rasterio.open(out_file, "w", **profile) as dst:
        dst.write(max_data.astype(np.float32), 1)


def _compute_eta(risk_folder, out_file, threshold=0.05, pattern=None):
    if pattern:
        files = sorted(glob.glob(os.path.join(risk_folder, pattern)))
    else:
        files = sorted(glob.glob(os.path.join(risk_folder, "risk_*.tif")))
    files = [f for f in files if "max_risk" not in f and "eta" not in f]
    if not files:
        return
    eta = None
    profile = None
    for hour_idx, rf in enumerate(files, start=1):
        with rasterio.open(rf) as src:
            risk = src.read(1)
            if eta is None:
                eta     = np.full_like(risk, np.nan, dtype=np.float32)
                profile = src.profile
                profile.update(dtype=np.float32, nodata=np.nan)
            mask = (risk >= threshold) & np.isnan(eta)
            eta[mask] = hour_idx
    if eta is not None and profile is not None:
        with rasterio.open(out_file, "w", **profile) as dst:
            dst.write(eta, 1)


# ── Live point query (used by /api/dynamic/risk) ─────────────────
def query_dynamic_risk_at_point(lat: float, lng: float) -> dict:
    """
    Return the current-hour dynamic flood risk at a lat/lng point.
    Reads the most recent forecast_risk TIF for the current UTC hour.
    Falls back to mock if TIFs aren't available.
    """
    if not HAS_RASTERIO:
        return _mock_dynamic(lat, lng)

    folder = _abs("data_dynamic_processed/dynamic_risk/forecast")
    now_str = datetime.datetime.utcnow().strftime("%Y%m%d_%H")
    # Try current hour, then previous hours
    for delta in range(6):
        t = datetime.datetime.utcnow() - datetime.timedelta(hours=delta)
        ts = t.strftime("%Y%m%d_%H")
        candidate = os.path.join(folder, f"risk_{ts}.tif")
        if os.path.exists(candidate):
            return _sample_dynamic_tif(candidate, lat, lng, ts)

    return _mock_dynamic(lat, lng)


def _sample_dynamic_tif(tif_path, lat, lng, hour_str):
    try:
        import pyproj
        transformer = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:26918", always_xy=True)
        x, y = transformer.transform(lng, lat)
        with rasterio.open(tif_path) as src:
            nodata = src.nodata
            row, col = src.index(x, y)
            if 0 <= row < src.height and 0 <= col < src.width:
                val = src.read(1)[row, col]
                if nodata is not None and val == nodata:
                    return _mock_dynamic(lat, lng)
                score = float(np.clip(val, 0, 1))
                level = _risk_level(score)
                return {
                    "source": "dynamic_tif",
                    "hour":   hour_str,
                    "risk_score": round(score, 4),
                    "risk_level": level,
                    "risk_pct":   round(score * 100),
                    "depth": _depth_from_score(score),
                    "in_bounds": True,
                }
    except Exception as e:
        pass
    return _mock_dynamic(lat, lng)


def _mock_dynamic(lat, lng):
    """Weather-driven mock when TIFs aren't ready yet."""
    import math, random
    base = 0.35 + abs(math.sin(lat * 100) * 0.15)
    score = float(np.clip(base + random.uniform(-0.05, 0.05), 0, 1))
    level = _risk_level(score)
    return {
        "source": "mock",
        "risk_score": round(score, 4),
        "risk_level": level,
        "risk_pct":   round(score * 100),
        "depth": _depth_from_score(score),
        "in_bounds": True,
    }


def _risk_level(score):
    if score >= 0.8: return "very_high"
    if score >= 0.6: return "high"
    if score >= 0.4: return "moderate"
    if score >= 0.2: return "low"
    return "none"


def _depth_from_score(score):
    cm = round(score * 120, 1)
    label = (
        "No flooding expected" if score < 0.2 else
        "Minor puddles possible" if score < 0.4 else
        "Shallow street flooding" if score < 0.6 else
        "Roads may be impassable" if score < 0.8 else
        "Severe building-level flooding"
    )
    return {"cm": f"{cm} cm", "label": label}


# ── Pipeline status ───────────────────────────────────────────────
def get_pipeline_status():
    folder = _abs("data_dynamic_processed/dynamic_risk/forecast")
    risk_files = sorted(glob.glob(os.path.join(folder, "risk_*.tif")))
    risk_files = [f for f in risk_files if "max_risk" not in f and "eta" not in f]

    soil_folder = _abs("data_dynamic_raw/soil/latest")
    soil_files  = sorted(glob.glob(os.path.join(soil_folder, "wf_*.tif")))

    rain_folder = _abs("data_dynamic_raw/rainfall/forecast")
    rain_files  = sorted(glob.glob(os.path.join(rain_folder, "forecast_*.csv")))
    rain_tifs   = sorted(glob.glob(os.path.join(rain_folder, "rain_*.tif")))

    server_dir = os.path.dirname(os.path.abspath(__file__))
    max_risk = os.path.join(server_dir, "max_risk.tif")
    eta      = os.path.join(server_dir, "eta.tif")

    # Hindcast outputs (Hurricane Ida 2021-09-01)
    hindcast_folder   = _abs("data_dynamic_processed/dynamic_risk/2021-09-01")
    hindcast_risk     = sorted(glob.glob(os.path.join(hindcast_folder, "risk_*.tif")))
    eta_ida           = os.path.join(hindcast_folder, "eta_ida.tif")
    max_risk_ida      = os.path.join(hindcast_folder, "max_risk_ida.tif")
    street_ida        = _abs("street_ida.geojson")

    street_path = os.path.join(server_dir, "street.geojson")

    _ensure_pandas()
    _ensure_rasterio()
    return {
        "project_root":      FLOOD_PROJECT_ROOT,
        "static_tif":        STATIC_TIF,
        "static_tif_exists": os.path.exists(STATIC_TIF),
        # Forecast
        "risk_rasters":      len(risk_files),
        "latest_risk":       os.path.basename(risk_files[-1]) if risk_files else None,
        "soil_rasters":      len(soil_files),
        "latest_soil":       os.path.basename(soil_files[-1]) if soil_files else None,
        "rain_tifs":         len(rain_tifs),
        "rain_csvs":         len(rain_files),
        "latest_rain_csv":   os.path.basename(rain_files[-1]) if rain_files else None,
        "max_risk_ready":    os.path.exists(max_risk),
        "eta_ready":         os.path.exists(eta),
        "street_ready":      os.path.exists(street_path),
        # Hindcast (Ida)
        "hindcast": {
            "event_date":     "2021-09-01",
            "risk_rasters":   len(hindcast_risk),
            "eta_ida_ready":  os.path.exists(eta_ida),
            "max_risk_ready": os.path.exists(max_risk_ida),
            "street_geojson_ready": os.path.exists(street_ida),
        },
        "has_rasterio":      HAS_RASTERIO,
        "has_pandas":        HAS_PANDAS,
    }
