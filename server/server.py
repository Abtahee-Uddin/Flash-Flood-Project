"""
Hudson County Flash Flood — GeoTIFF Tile Server
================================================
Reads static_flood_vulnerability.tif (EPSG:26918, UTM 18N)
and exposes:

  GET /api/risk?lat=40.73&lng=-74.07
      → { "risk": 0.54, "level": "moderate", ... }

  GET /api/tiles/{z}/{x}/{y}.png
      → PNG map tile colored by flood risk

  GET /api/health
      → { "status": "ok", "tif_loaded": true }

Run:
  pip install flask flask-cors rasterio numpy pyproj pillow
  python server.py

The server runs on http://localhost:5000
The Vite frontend proxies /api → localhost:5000
"""

import os
import io
import math
import struct
import threading

# Dynamic pipeline
try:
    import sys, os as _os
    sys.path.insert(0, _os.path.dirname(__file__))
    import dynamic_core
    HAS_DYNAMIC = True
    print("  Dynamic core: ✓ loaded")
except Exception as _de:
    HAS_DYNAMIC = False
    print(f"  Dynamic core: ✗ ({_de})")
import numpy as np
from flask import Flask, jsonify, request, send_file, abort
from flask_cors import CORS

# ── Try importing geo libs gracefully ─────────────────────────
try:
    import rasterio
    from rasterio.transform import rowcol
    from pyproj import Transformer
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False
    print("WARNING: rasterio/pyproj not installed. Run: pip install rasterio pyproj flask flask-cors pillow numpy")

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("WARNING: pillow not installed. Tiles will not render. Run: pip install pillow")

app = Flask(__name__)
CORS(app)

# ── Config ─────────────────────────────────────────────────────
_SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SERVER_DIR)

TIF_PATH = os.environ.get(
    "TIF_PATH",
    os.path.join(_PROJECT_ROOT, "data_static", "static_fv_10m.tif")
)

# Known stats from QGIS metadata
TIF_MIN = 0.012402608059347
TIF_MAX = 0.77326864004135
TIF_NODATA = -3.40282e+38

# Hudson County bounds (WGS84 for validation)
HUDSON_BOUNDS = {
    "min_lat": 40.6850, "max_lat": 40.7920,
    "min_lng": -74.1300, "max_lng": -74.0200,
}

# ── Load raster ─────────────────────────────────────────────────
raster_data = None
raster_transform = None
raster_crs = None
transformer_to_utm = None
transformer_to_wgs = None

def load_raster():
    global raster_data, raster_transform, raster_crs
    global transformer_to_utm, transformer_to_wgs

    if not HAS_RASTERIO:
        print("Rasterio not available — running in mock mode")
        return False

    if not os.path.exists(TIF_PATH):
        print(f"TIF not found at: {TIF_PATH}")
        print("Set TIF_PATH env var to the correct path, e.g.:")
        print("  set TIF_PATH=path\\to\\static_fv_10m.tif")
        return False

    print(f"Loading raster: {TIF_PATH}")
    try:
        with rasterio.open(TIF_PATH) as src:
            print(f"  CRS: {src.crs}")
            print(f"  Size: {src.width} x {src.height}")
            print(f"  Bounds: {src.bounds}")
            raster_transform = src.transform
            raster_crs = src.crs

            # For a 1GB file we do NOT load all into memory.
            # We store the path and open per-request with windowed reads.
            # But we DO load a downsampled overview for tile rendering.
            # Check for overviews
            overview_level = min(len(src.overviews(1)) - 1, 3) if src.overviews(1) else None
            if overview_level is not None and overview_level >= 0:
                factor = src.overviews(1)[overview_level]
                print(f"  Using overview level {overview_level} (factor {factor})")
                out_shape = (1, src.height // factor, src.width // factor)
            else:
                # No overviews — use 1/16 downscale for overview
                factor = 16
                out_shape = (1, src.height // factor, src.width // factor)
                print(f"  No overviews found. Reading at 1/{factor} scale for tile cache.")

            raster_data = src.read(1, out_shape=out_shape[1:], resampling=rasterio.enums.Resampling.average)
            print(f"  Overview loaded: {raster_data.shape}")

        # Coordinate transformers
        transformer_to_utm = Transformer.from_crs("EPSG:4326", "EPSG:26918", always_xy=True)
        transformer_to_wgs = Transformer.from_crs("EPSG:26918", "EPSG:4326", always_xy=True)

        print("Raster loaded successfully.")
        return True
    except Exception as e:
        print(f"Error loading raster: {e}")
        return False

raster_loaded = load_raster()

# ── Helpers ─────────────────────────────────────────────────────
def normalize_risk(raw_value: float) -> float:
    """Normalize raw GeoTIFF value (0.012–0.773) to 0–1."""
    if raw_value is None or raw_value <= TIF_NODATA / 2:
        return None
    clamped = max(TIF_MIN, min(TIF_MAX, float(raw_value)))
    return (clamped - TIF_MIN) / (TIF_MAX - TIF_MIN)

def risk_to_level(score: float) -> str:
    if score is None: return "unknown"
    if score < 0.20: return "none"
    if score < 0.40: return "low"
    if score < 0.60: return "moderate"
    if score < 0.80: return "high"
    return "very_high"

def risk_to_color_rgba(score: float) -> tuple:
    """Return RGBA tuple for a risk score 0–1."""
    if score is None:
        return (0, 0, 0, 0)
    if score < 0.20:
        return (34, 197, 94, 180)    # green
    elif score < 0.40:
        return (132, 204, 22, 180)   # lime
    elif score < 0.60:
        return (234, 179, 8, 180)    # yellow
    elif score < 0.80:
        return (249, 115, 22, 180)   # orange
    else:
        return (239, 68, 68, 200)    # red

def sample_raster_at_point(lat: float, lng: float) -> float | None:
    """Sample the GeoTIFF at a WGS84 lat/lng. Returns raw value or None."""
    if not HAS_RASTERIO or not os.path.exists(TIF_PATH):
        return _mock_risk(lat, lng)

    try:
        # Convert WGS84 → UTM 18N
        easting, northing = transformer_to_utm.transform(lng, lat)

        with rasterio.open(TIF_PATH) as src:
            # Convert UTM → pixel row/col
            row, col = rowcol(src.transform, easting, northing)
            row, col = int(row), int(col)

            if row < 0 or col < 0 or row >= src.height or col >= src.width:
                return None  # Outside raster

            # Read single pixel with small window for accuracy
            window = rasterio.windows.Window(col, row, 1, 1)
            value = src.read(1, window=window)[0, 0]

            if value <= TIF_NODATA / 2:
                return None
            return float(value)

    except Exception as e:
        print(f"Raster sample error: {e}")
        return _mock_risk(lat, lng)

def _mock_risk(lat: float, lng: float) -> float:
    """
    Fallback mock when TIF not available.
    Based on known Hudson County flood geography.
    """
    # Hoboken (very flat, low)
    if 40.735 < lat < 40.760 and -74.042 < lng < -74.025:
        return 0.65 + (abs(lat - 40.747) * -2)
    # Jersey City waterfront
    if 40.710 < lat < 40.730 and -74.040 < lng < -74.025:
        return 0.70
    # Bayonne
    if lat < 40.710 and lng < -74.075:
        return 0.72
    # Secaucus marshes
    if 40.760 < lat < 40.790 and -74.090 < lng < -74.055:
        return 0.60
    # Heights (high elevation, lower risk)
    if 40.742 < lat < 40.758 and -74.085 < lng < -74.060:
        return 0.25
    # Default mid-range
    base = 0.35 + abs(math.sin(lat * 100) * 0.15)
    return min(0.75, max(0.05, base))

# ── Tile math ──────────────────────────────────────────────────
def tile_to_bbox(z: int, x: int, y: int):
    """Convert TMS tile coordinates to WGS84 bbox (west, south, east, north)."""
    def _tile_to_lng(x, z): return x / 2**z * 360 - 180
    def _tile_to_lat(y, z):
        n = math.pi - 2 * math.pi * y / 2**z
        return math.degrees(math.atan(math.sinh(n)))

    west = _tile_to_lng(x, z)
    east = _tile_to_lng(x + 1, z)
    north = _tile_to_lat(y, z)
    south = _tile_to_lat(y + 1, z)
    return west, south, east, north

def utm_from_tile(z, x, y, tile_size=256):
    """Get UTM bounding box for a tile."""
    west, south, east, north = tile_to_bbox(z, x, y)
    if not HAS_RASTERIO:
        return None
    w, s = transformer_to_utm.transform(west, south)
    e, n = transformer_to_utm.transform(east, north)
    return w, s, e, n

# ── API Routes ─────────────────────────────────────────────────

@app.route("/api/health")
def health():
    return jsonify({
        "status": "ok",
        "tif_loaded": raster_loaded,
        "tif_path": TIF_PATH,
        "tif_exists": os.path.exists(TIF_PATH),
        "has_rasterio": HAS_RASTERIO,
        "has_pil": HAS_PIL,
        "mode": "live" if raster_loaded else "mock",
    })

@app.route("/api/risk")
def get_risk():
    """
    Query flood risk at a point.
    GET /api/risk?lat=40.73&lng=-74.07
    """
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        abort(400, "lat and lng must be valid numbers")

    # Bounds check — Hudson County
    in_bounds = (
        HUDSON_BOUNDS["min_lat"] <= lat <= HUDSON_BOUNDS["max_lat"] and
        HUDSON_BOUNDS["min_lng"] <= lng <= HUDSON_BOUNDS["max_lng"]
    )

    raw = sample_raster_at_point(lat, lng)
    score = normalize_risk(raw)

    if score is None and in_bounds:
        # NoData pixel inside bounds — treat as no flood risk (impervious/elevated)
        score = 0.05

    level = risk_to_level(score)

    depth_map = {
        "none": {"label": "No flooding expected", "cm": "0 cm"},
        "low": {"label": "Minor puddles possible", "cm": "0–5 cm"},
        "moderate": {"label": "Shallow street water", "cm": "5–15 cm"},
        "high": {"label": "Roads may be impassable", "cm": "15–30 cm"},
        "very_high": {"label": "Building-level flooding risk", "cm": "30–60+ cm"},
        "unknown": {"label": "Outside study area", "cm": "N/A"},
    }

    return jsonify({
        "lat": lat,
        "lng": lng,
        "raw_value": raw,
        "risk_score": round(score, 4) if score is not None else None,
        "risk_level": level,
        "risk_pct": round(score * 100) if score is not None else None,
        "in_bounds": in_bounds,
        "depth": depth_map.get(level, depth_map["unknown"]),
        "source": "live_tif" if raster_loaded else "mock",
    })

@app.route("/api/tiles/<int:z>/<int:x>/<int:y>.png")
def get_tile(z: int, x: int, y: int):
    """
    Render a 256×256 PNG tile colored by flood risk.
    Overlays on the Leaflet base map.
    Only renders at zoom 10–18 over Hudson County.
    """
    if not HAS_PIL:
        abort(503, "PIL not installed")
    if z < 10 or z > 18:
        # Return transparent tile
        return _transparent_tile()

    west, south, east, north = tile_to_bbox(z, x, y)

    # Skip tiles completely outside Hudson County (with buffer)
    buf = 0.05
    if (east < HUDSON_BOUNDS["min_lng"] - buf or
        west > HUDSON_BOUNDS["max_lng"] + buf or
        north < HUDSON_BOUNDS["min_lat"] - buf or
        south > HUDSON_BOUNDS["max_lat"] + buf):
        return _transparent_tile()

    TILE_SIZE = 256
    # Sample grid (lower res for speed)
    SAMPLE = 64 if z < 14 else 128

    img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    pixels = img.load()

    lat_step = (north - south) / SAMPLE
    lng_step = (east - west) / SAMPLE
    cell_px = TILE_SIZE // SAMPLE

    for gy in range(SAMPLE):
        lat = north - gy * lat_step - lat_step / 2
        for gx in range(SAMPLE):
            lng = west + gx * lng_step + lng_step / 2

            # Rough bounds check
            in_hudson = (
                HUDSON_BOUNDS["min_lat"] <= lat <= HUDSON_BOUNDS["max_lat"] and
                HUDSON_BOUNDS["min_lng"] <= lng <= HUDSON_BOUNDS["max_lng"]
            )
            if not in_hudson:
                continue

            raw = sample_raster_at_point(lat, lng)
            score = normalize_risk(raw)
            if score is None:
                continue

            r, g, b, a = risk_to_color_rgba(score)

            # Fill cell pixels
            px_x = gx * cell_px
            px_y = gy * cell_px
            for dy in range(cell_px):
                for dx in range(cell_px):
                    if 0 <= px_x + dx < TILE_SIZE and 0 <= px_y + dy < TILE_SIZE:
                        pixels[px_x + dx, px_y + dy] = (r, g, b, a)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")

def _transparent_tile():
    if not HAS_PIL:
        abort(503)
    img = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return send_file(buf, mimetype="image/png")

@app.route("/api/search-risk")
def search_risk():
    """
    Get risk for a list of points (bulk).
    GET /api/search-risk?points=lat1,lng1|lat2,lng2
    """
    raw_points = request.args.get("points", "")
    results = []
    for pt in raw_points.split("|")[:20]:  # max 20
        try:
            lat, lng = map(float, pt.split(","))
            raw = sample_raster_at_point(lat, lng)
            score = normalize_risk(raw)
            results.append({
                "lat": lat, "lng": lng,
                "risk_score": round(score, 4) if score else 0,
                "risk_level": risk_to_level(score),
            })
        except Exception:
            continue
    return jsonify(results)


@app.route("/api/vector-risk")
def vector_risk():
    """
    Fetch OSM roads + buildings in a bbox and sample TIF risk for each feature centroid.
    Used to color roads/buildings by static flood vulnerability in the frontend.

    GET /api/vector-risk?north=40.75&south=40.72&east=-74.02&west=-74.08&types=roads,buildings

    Returns GeoJSON FeatureCollection with risk_score, risk_level, risk_color on each feature.
    Capped at ~200 features for performance.
    """
    try:
        north = float(request.args.get("north"))
        south = float(request.args.get("south"))
        east  = float(request.args.get("east"))
        west  = float(request.args.get("west"))
        types = request.args.get("types", "roads,buildings")
    except (TypeError, ValueError):
        abort(400, "north/south/east/west required as floats")

    # Sanity check bbox size — reject very large requests
    if (north - south) > 0.08 or (east - west) > 0.12:
        abort(400, "Bounding box too large. Zoom in further.")

    features = []

    # Query Overpass API for OSM features
    overpass_url = "https://overpass-api.de/api/interpreter"
    bbox_str = f"{south},{west},{north},{east}"

    queries = []
    if "roads" in types:
        queries.append(f'way["highway"]({bbox_str});')
    if "buildings" in types:
        queries.append(f'way["building"]({bbox_str});')

    if not queries:
        return jsonify({"type": "FeatureCollection", "features": []})

    overpass_query = f"""
    [out:json][timeout:15];
    (
      {''.join(queries)}
    );
    out center 200;
    """

    try:
        import urllib.request
        import urllib.parse
        data = urllib.parse.urlencode({"data": overpass_query}).encode()
        req = urllib.request.Request(overpass_url, data=data, method="POST")
        req.add_header("User-Agent", "HudsonFloodApp/1.0")
        with urllib.request.urlopen(req, timeout=15) as resp:
            osm_data = __import__('json').loads(resp.read().decode())
    except Exception as e:
        # If Overpass is unavailable, return empty rather than error
        return jsonify({"type": "FeatureCollection", "features": [], "error": str(e)})

    RISK_COLORS_MAP = {
        "none":      "#22c55e",
        "low":       "#84cc16",
        "moderate":  "#eab308",
        "high":      "#f97316",
        "very_high": "#ef4444",
        "unknown":   "#7a9ab5",
    }

    for element in osm_data.get("elements", [])[:200]:
        if "center" not in element:
            continue
        lat = element["center"]["lat"]
        lng = element["center"]["lon"]
        tags = element.get("tags", {})

        raw = sample_raster_at_point(lat, lng)
        score = normalize_risk(raw)
        if score is None:
            score = 0.05
        level = risk_to_level(score)

        feature_type = "building" if "building" in tags else "road"
        name = tags.get("name") or tags.get("highway") or tags.get("building") or "Unknown"

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lng, lat]},
            "properties": {
                "osm_id": element.get("id"),
                "name": name,
                "feature_type": feature_type,
                "highway": tags.get("highway"),
                "building": tags.get("building"),
                "risk_score": round(score, 4),
                "risk_level": level,
                "risk_pct": round(score * 100),
                "risk_color": RISK_COLORS_MAP.get(level, "#7a9ab5"),
                "depth_label": {
                    "none": "No flooding expected",
                    "low": "Minor puddles possible",
                    "moderate": "Shallow street water",
                    "high": "Roads may be impassable",
                    "very_high": "Building-level flooding risk",
                }.get(level, "Unknown"),
            }
        })

    return jsonify({
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "bbox": {"north": north, "south": south, "east": east, "west": west},
    })


# ── Pre-colored roads cache ────────────────────────────────────
_roads_cache = None
_roads_cache_mode = None  # 'live' or 'mock'

@app.route("/api/roads")
def get_roads():
    """
    Returns hudson_roads.geojson with risk_score + risk_color baked in per road.
    Results are cached in memory after first call.
    """
    global _roads_cache, _roads_cache_mode
    
    current_mode = 'live' if raster_loaded else 'mock'
    if _roads_cache is not None and _roads_cache_mode == current_mode:
        from flask import Response
        import json as _json
        return Response(_roads_cache, mimetype='application/json')

    # Load base GeoJSON from public folder
    geojson_path = os.path.join(os.path.dirname(__file__), '..', 'public', 'hudson_roads.geojson')
    geojson_path = os.path.normpath(geojson_path)
    
    if not os.path.exists(geojson_path):
        abort(404, "Roads GeoJSON not found")

    import json as _json
    with open(geojson_path) as f:
        roads = _json.load(f)

    RISK_COLORS_MAP = {
        "none":      "#22c55e",
        "low":       "#84cc16",
        "moderate":  "#eab308",
        "high":      "#f97316",
        "very_high": "#ef4444",
    }
    ROAD_WEIGHTS = {
        'S1100': 3.5,   # Highway
        'S1200': 2.5,   # Major road
        'S1400': 1.5,   # Local street
        'S1630': 1.5,   # Ramp
        'S1500': 1.2,
        '99999': 1.2,
    }

    print(f"Sampling TIF for {len(roads['features'])} roads...")
    for feat in roads['features']:
        # Use midpoint of first line segment as sample point
        coords = feat['geometry']['coordinates']
        if not coords or not coords[0]:
            continue
        line = coords[0]
        mid_idx = len(line) // 2
        lng, lat = line[mid_idx][0], line[mid_idx][1]

        raw = sample_raster_at_point(lat, lng)
        score = normalize_risk(raw)
        if score is None:
            score = 0.1
        level = risk_to_level(score)

        rc = feat['properties'].get('roadclass', 'S1400')
        feat['properties']['risk_score'] = round(score, 3)
        feat['properties']['risk_level'] = level
        feat['properties']['risk_pct'] = round(score * 100)
        feat['properties']['risk_color'] = RISK_COLORS_MAP.get(level, '#334155')
        feat['properties']['weight'] = ROAD_WEIGHTS.get(rc, 1.5)

    print("Road sampling complete.")
    _roads_cache = _json.dumps(roads, separators=(',', ':'))
    _roads_cache_mode = current_mode

    from flask import Response
    return Response(_roads_cache, mimetype='application/json')

@app.route("/api/roads/invalidate")
def invalidate_roads_cache():
    global _roads_cache, _roads_cache_mode
    _roads_cache = None
    _roads_cache_mode = None
    return jsonify({"status": "cache cleared"})


# ── Buildings spatial index ────────────────────────────────────
_buildings_index = None
_buildings_risk_cache = {}   # centroid key -> (score, level, color)

def _load_buildings_index():
    global _buildings_index
    if _buildings_index is not None:
        return
    idx_path = os.path.join(os.path.dirname(__file__), 'buildings_index.json')
    if not os.path.exists(idx_path):
        print("  Buildings index not found — building features disabled")
        return
    import json as _json
    with open(idx_path) as f:
        _buildings_index = _json.load(f)
    total = sum(len(v) for v in _buildings_index.values())
    print(f"  Buildings index loaded: {len(_buildings_index)} cells, {total:,} buildings")

# Load at startup
_load_buildings_index()

RISK_COLORS_BLDG = {
    "none":      "#22c55e",
    "low":       "#84cc16",
    "moderate":  "#eab308",
    "high":      "#f97316",
    "very_high": "#ef4444",
}
CELL_SIZE = 0.005

@app.route("/api/buildings")
def get_buildings():
    """
    Returns GeoJSON buildings within a bbox, colored by static flood vulnerability.
    GET /api/buildings?west=-74.08&south=40.72&east=-74.04&north=40.75
    Capped at 600 buildings per request.
    """
    import json as _json

    if _buildings_index is None:
        return jsonify({"type":"FeatureCollection","features":[],"error":"Index not loaded"})

    try:
        west  = float(request.args.get("west"))
        south = float(request.args.get("south"))
        east  = float(request.args.get("east"))
        north = float(request.args.get("north"))
    except (TypeError, ValueError):
        abort(400, "west/south/east/north required as floats")

    if (north - south) > 0.35 or (east - west) > 0.45:
        abort(400, "Bbox too large — zoom in further")

    # Find all grid cells that overlap the bbox
    cell_x_min = int(west  / CELL_SIZE) - 1
    cell_x_max = int(east  / CELL_SIZE) + 1
    cell_y_min = int(south / CELL_SIZE) - 1
    cell_y_max = int(north / CELL_SIZE) + 1

    candidates = []
    for cx in range(cell_x_min, cell_x_max + 1):
        for cy in range(cell_y_min, cell_y_max + 1):
            key = f"{cx}_{cy}"
            if key in _buildings_index:
                candidates.extend(_buildings_index[key])

    # Filter to exact bbox and cap
    in_bbox = [b for b in candidates
               if west <= b['cx'] <= east and south <= b['cy'] <= north]
    in_bbox = in_bbox[:400]

    features = []
    for bldg in in_bbox:
        cx, cy = bldg['cx'], bldg['cy']
        cache_key = f"{cx},{cy}"

        if cache_key not in _buildings_risk_cache:
            raw = sample_raster_at_point(cy, cx)
            score = normalize_risk(raw)
            if score is None: score = 0.1
            level = risk_to_level(score)
            color = RISK_COLORS_BLDG.get(level, "#334155")
            _buildings_risk_cache[cache_key] = (round(score,3), level, color, round(score*100))

        score, level, color, pct = _buildings_risk_cache[cache_key]

        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [bldg['ring']]},
            "properties": {
                "pin":        bldg.get("pin",""),
                "mun":        bldg.get("mun",""),
                "cx":         cx,
                "cy":         cy,
                "risk_score": score,
                "risk_level": level,
                "risk_pct":   pct,
                "risk_color": color,
            }
        })

    return jsonify({
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "total_in_bbox": len(in_bbox),
    })


# ── Street-level segment data ──────────────────────────────────────
# Two separate datasets:
#   - _historical_segments:  Hurricane Ida (street_ida.geojson)  → /api/historical/*
#   - _forecast_segments:    Live forecast (street.geojson)      → /api/forecast/*
# Each has its own grid index for fast nearest-segment lookups.
#
# Legacy name `_street_segments` is kept as an alias pointing at the
# historical (Ida) dataset so /api/hindcast/street-risk keeps working.

_historical_segments: list = []
_forecast_segments:  list = []

def _load_segments_geojson(path: str, label: str):
    """
    Parse a street-stats GeoJSON into a list of segment dicts.

    GeoJSON files are always in EPSG:4326 (WGS84 degrees).  The grid index
    built by _build_seg_index uses 500 m cells, so cx/cy must be in UTM
    metres (EPSG:26918).  We convert every midpoint here so the index works
    regardless of which tool wrote the file.
    """
    if not os.path.exists(path):
        print(f"  {label}: file not found at {path} — endpoints disabled")
        return []
    import json as _json
    with open(path) as f:
        gj = _json.load(f)

    # Use the global transformer if available; fall back to a fresh one.
    _to_utm = transformer_to_utm
    if _to_utm is None:
        try:
            from pyproj import Transformer as _T
            _to_utm = _T.from_crs("EPSG:4326", "EPSG:26918", always_xy=True)
        except Exception:
            _to_utm = None

    segs = []
    for feat in gj.get('features', []):
        props    = feat.get('properties', {})
        max_risk = props.get('max_risk')
        eta_hour = props.get('eta_hour')
        if max_risk is None and eta_hour is None:
            continue
        geom   = feat.get('geometry') or {}
        gtype  = geom.get('type', '')
        coords = geom.get('coordinates')
        if not coords:
            continue
        # Flatten MultiLineString [[ring0_pts], [ring1_pts], …] → all pts
        if gtype == 'MultiLineString':
            flat = [pt for ring in coords for pt in ring]
        else:  # LineString
            flat = coords
        if not flat:
            continue
        mid = flat[len(flat) // 2]
        # Ensure cx/cy are in UTM metres for the 500 m grid index.
        # Detect CRS by magnitude: WGS84 longitudes are always in [-180, 180];
        # UTM eastings for Hudson County are ~580,000 m.
        # Only transform when the coordinates look like degrees.
        if _to_utm is not None and abs(mid[0]) <= 180:
            cx, cy = _to_utm.transform(mid[0], mid[1])
        else:
            cx, cy = mid[0], mid[1]   # already in UTM metres (or no transformer)
        segs.append({
            'cx': cx, 'cy': cy,
            'max_risk': max_risk,
            'eta_hour': eta_hour,
            'name':     props.get('name'),
            'highway':  props.get('highway'),
        })
    print(f"  {label} loaded: {len(segs):,} segments")
    return segs


def _load_all_street_data():
    """Load both the historical (Ida) and the forecast segment datasets."""
    global _historical_segments, _forecast_segments
    base = os.path.dirname(__file__)
    _historical_segments = _load_segments_geojson(
        os.path.join(base, 'street_ida.geojson'), 'historical (Ida)'
    )
    _forecast_segments = _load_segments_geojson(
        os.path.join(base, 'street.geojson'), 'forecast'
    )


_load_all_street_data()

# Legacy alias — older code paths reference `_street_segments` directly.
# Point it at the historical (Ida) dataset so /api/hindcast/street-risk
# continues to return Ida data.
_street_segments = _historical_segments


@app.route("/api/hindcast/street-risk")
def hindcast_street_risk():
    """
    Returns nearest street segment's hindcast stats for a WGS84 lat/lng click.
    GET /api/hindcast/street-risk?lat=40.73&lng=-74.07

    Response fields:
      max_risk  - peak risk value along the segment (0–1)
      eta_hour  - hour index (1-48) when risk first reached threshold
      eta_label - human-readable timestamp for that hour
      name      - street name (may be null)
      highway   - OSM highway tag
      dist_m    - distance from click to nearest segment centroid (metres)
    """
    if not _street_segments:
        return jsonify({"error": "Street hindcast data not loaded"}), 503

    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        return jsonify({"error": "lat and lng required"}), 400

    if not HAS_RASTERIO:
        return jsonify({"error": "pyproj not available"}), 503

    # Reproject click point to EPSG:26918 (same CRS as street_ida.geojson)
    easting, northing = transformer_to_utm.transform(lng, lat)

    # Linear scan over ~15k segments — typically < 5 ms
    best    = None
    best_d2 = float('inf')
    for seg in _street_segments:
        dx = seg['cx'] - easting
        dy = seg['cy'] - northing
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best    = seg

    if best is None:
        return jsonify({"error": "No segments found"}), 404

    import math, datetime as _dt
    dist_m = math.sqrt(best_d2)

    # Build human-readable ETA label.
    # Hour index 1 = 2021-09-01 00:00 UTC; hour N = midnight + (N-1) hours.
    eta_label = None
    if best['eta_hour'] is not None:
        base = _dt.datetime(2021, 9, 1, 0, 0, tzinfo=_dt.timezone.utc)
        ts   = base + _dt.timedelta(hours=int(best['eta_hour']) - 1)
        eta_label = f"Hour {int(best['eta_hour'])}  ({ts.strftime('%H:%M UTC, %b')} {ts.day})"

    return jsonify({
        "max_risk":  round(best['max_risk'], 4) if best['max_risk'] is not None else None,
        "eta_hour":  int(best['eta_hour'])       if best['eta_hour']  is not None else None,
        "eta_label": eta_label,
        "name":      best['name'],
        "highway":   best['highway'],
        "dist_m":    round(dist_m, 1),
    })


# ── Forecast + Historical modes (street-level stats → coloring) ────
# Both modes share the same rendering + query logic but use different
# input datasets:
#   - forecast:    street.geojson      (live forecast)
#   - historical:  street_ida.geojson  (Hurricane Ida, 2021-09-01)
# Each dataset has its own 500m-cell grid index for fast nearest-
# segment lookups over ~15k segments.

_FORECAST_CELL_M    = 500     # metres per index cell in UTM 26918
_FORECAST_MAX_RISK  = 0.15    # normaliser — peak observed ≈ 0.133 (Ida)

# Per-dataset state. Indexed by dataset key.
_seg_indices: dict = {}   # { 'forecast': {...}, 'historical': {...} }
_dataset_roads_cache: dict = {}   # { 'forecast': json_str, 'historical': json_str }

# Thresholds on raw max_risk — derived from observed p25/p50/p75/p90 of
# street_ida.geojson (0.07 / 0.10 / 0.11 / 0.115).
def _forecast_level(max_risk):
    if max_risk is None:
        return "unknown"
    if max_risk >= 0.12:  return "very_high"
    if max_risk >= 0.09:  return "high"
    if max_risk >= 0.06:  return "moderate"
    if max_risk >= 0.03:  return "low"
    return "none"


# ETA base dates — historical is Ida (2021-09-01); forecast is "today"
# at server startup. For historical events added later, extend this map.
import datetime as _dt_module
_ETA_BASES = {
    'historical': _dt_module.datetime(2021, 9, 1, 0, 0, tzinfo=_dt_module.timezone.utc),
    'forecast':   _dt_module.datetime.now(_dt_module.timezone.utc).replace(
                      minute=0, second=0, microsecond=0),
}

def _eta_label(eta_hour, dataset='historical'):
    if eta_hour is None:
        return None
    base = _ETA_BASES.get(dataset, _ETA_BASES['historical'])
    ts   = base + _dt_module.timedelta(hours=int(eta_hour) - 1)
    return f"Hour {int(eta_hour)}  ({ts.strftime('%H:%M UTC, %b')} {ts.day})"


# Keep legacy function name used by /api/hindcast/street-risk
def _forecast_eta_label(eta_hour):
    return _eta_label(eta_hour, 'historical')


def _segments_for(dataset: str):
    """Return the list of segments for a given dataset key."""
    if dataset == 'forecast':
        return _forecast_segments
    # default → historical (Ida)
    return _historical_segments


def _build_seg_index(dataset: str):
    """Build and cache a 500m-cell grid for a given dataset."""
    if dataset in _seg_indices:
        return _seg_indices[dataset]
    segs = _segments_for(dataset)
    idx = {}
    import math as _math
    for seg in segs:
        raw_cx, raw_cy = seg['cx'], seg['cy']
        if raw_cx != raw_cx or raw_cy != raw_cy:   # NaN check (NaN != NaN)
            continue
        cx = int(raw_cx // _FORECAST_CELL_M)
        cy = int(raw_cy // _FORECAST_CELL_M)
        idx.setdefault((cx, cy), []).append(seg)
    _seg_indices[dataset] = idx
    print(f"  {dataset} index: {len(idx):,} cells over {len(segs):,} segments")
    return idx


def _nearest_segment(dataset: str, easting: float, northing: float):
    """Find the nearest segment to a UTM point in the given dataset."""
    idx = _build_seg_index(dataset)
    if not idx:
        return None, float('inf')

    cx0 = int(easting // _FORECAST_CELL_M)
    cy0 = int(northing // _FORECAST_CELL_M)
    best    = None
    best_d2 = float('inf')
    for r in range(6):
        if r == 0:
            cells = [(cx0, cy0)]
        else:
            cells = []
            for d in range(-r, r + 1):
                cells.append((cx0 + d, cy0 - r))
                cells.append((cx0 + d, cy0 + r))
                if abs(d) != r:
                    cells.append((cx0 - r, cy0 + d))
                    cells.append((cx0 + r, cy0 + d))
        for c in cells:
            bucket = idx.get(c)
            if not bucket:
                continue
            for seg in bucket:
                dx = seg['cx'] - easting
                dy = seg['cy'] - northing
                d2 = dx * dx + dy * dy
                if d2 < best_d2:
                    best_d2 = d2
                    best    = seg
        if best is not None and r >= 1:
            break
    return best, best_d2


# Legacy wrapper used by /api/hindcast/street-risk — historical (Ida).
def _nearest_forecast_segment(easting: float, northing: float):
    return _nearest_segment('historical', easting, northing)


FORECAST_RISK_COLORS = {
    "none":      "#22c55e",
    "low":       "#84cc16",
    "moderate":  "#eab308",
    "high":      "#f97316",
    "very_high": "#ef4444",
    "unknown":   "#7a9ab5",
}


def _risk_point_response(dataset: str, source_tag: str):
    """
    Shared implementation of point-risk query for forecast + historical.
    Looks up nearest segment in the chosen dataset, builds the same
    response shape used by other /api/*/risk endpoints.
    """
    segs = _segments_for(dataset)
    if not segs:
        return jsonify({"error": f"{dataset.capitalize()} data not loaded"}), 503
    if not HAS_RASTERIO:
        return jsonify({"error": "pyproj not available"}), 503

    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        abort(400, "lat and lng required")

    easting, northing = transformer_to_utm.transform(lng, lat)
    seg, d2 = _nearest_segment(dataset, easting, northing)
    if seg is None:
        return jsonify({"error": "No segments found"}), 404

    import math as _math
    dist_m   = _math.sqrt(d2)
    max_risk = seg.get('max_risk')
    eta_hour = seg.get('eta_hour')
    level    = _forecast_level(max_risk)
    pct      = None
    score    = None
    if max_risk is not None:
        score = min(1.0, max(0.0, max_risk / _FORECAST_MAX_RISK))
        pct   = round(score * 100)

    # Depth labels mirror the dynamic/scenario endpoints
    depth_cm_map = {
        "none":      "0 cm",
        "low":       "0–5 cm",
        "moderate":  "5–15 cm",
        "high":      "15–30 cm",
        "very_high": "30–60+ cm",
        "unknown":   "N/A",
    }
    peak_word = "at peak" if dataset == 'historical' else "at forecast peak"
    depth_label_map = {
        "none":      f"No flooding expected {peak_word}",
        "low":       f"Minor puddles {peak_word}",
        "moderate":  f"Shallow street water {peak_word}",
        "high":      f"Roads impassable {peak_word}",
        "very_high": f"Severe flooding {peak_word}",
        "unknown":   f"Outside {dataset} area",
    }

    return jsonify({
        "lat": lat, "lng": lng,
        "risk_score": round(score, 4) if score is not None else None,
        "risk_level": level,
        "risk_pct":   pct,
        "depth": {
            "cm":    depth_cm_map.get(level, "N/A"),
            "label": depth_label_map.get(level, ""),
        },
        "in_bounds": True,
        "source":    source_tag,
        "dataset":   dataset,
        "hindcast": {
            "max_risk":  round(max_risk, 4) if max_risk is not None else None,
            "eta_hour":  int(eta_hour) if eta_hour is not None else None,
            "eta_label": _eta_label(eta_hour, dataset),
            "name":      seg.get('name'),
            "highway":   seg.get('highway'),
            "dist_m":    round(dist_m, 1),
            "dataset":   dataset,
        },
    })


@app.route("/api/forecast/risk")
def forecast_risk_point():
    """Point query for live forecast mode (uses street.geojson)."""
    return _risk_point_response('forecast', 'forecast')


@app.route("/api/historical/risk")
def historical_risk_point():
    """Point query for historical mode (uses street_ida.geojson — Hurricane Ida)."""
    return _risk_point_response('historical', 'historical')


def _build_roads_for_dataset(dataset: str):
    """Color every road in hudson_roads.geojson by nearest segment risk.
    Result is cached per dataset (segment data is static)."""
    if dataset in _dataset_roads_cache:
        return _dataset_roads_cache[dataset]

    segs = _segments_for(dataset)
    if not segs or not HAS_RASTERIO:
        return None

    _build_seg_index(dataset)

    import json as _json
    geojson_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__), '..', 'public', 'hudson_roads.geojson')
    )
    if not os.path.exists(geojson_path):
        return None

    with open(geojson_path) as f:
        roads = _json.load(f)

    ROAD_WEIGHTS = {'S1100': 3.5, 'S1200': 2.5, 'S1400': 1.5, 'S1630': 1.5}

    print(f"  [{dataset}] coloring {len(roads['features'])} roads from {len(segs)} segments...")
    for feat in roads['features']:
        coords = feat['geometry']['coordinates']
        if not coords or not coords[0]:
            continue
        line = coords[0]
        lng_c, lat_c = line[len(line) // 2][0], line[len(line) // 2][1]
        easting, northing = transformer_to_utm.transform(lng_c, lat_c)
        seg, _ = _nearest_segment(dataset, easting, northing)
        max_risk = seg.get('max_risk') if seg else None
        eta_hour = seg.get('eta_hour') if seg else None
        level    = _forecast_level(max_risk)
        score    = (min(1.0, max(0.0, max_risk / _FORECAST_MAX_RISK))
                    if max_risk is not None else 0.0)
        rc       = feat['properties'].get('roadclass', 'S1400')
        feat['properties'].update({
            'risk_score': round(score, 3),
            'risk_level': level,
            'risk_pct':   round(score * 100),
            'risk_color': FORECAST_RISK_COLORS.get(level, '#334155'),
            'max_risk':   round(max_risk, 4) if max_risk is not None else None,
            'eta_hour':   int(eta_hour) if eta_hour is not None else None,
            'weight':     ROAD_WEIGHTS.get(rc, 1.5),
            'dataset':    dataset,
        })

    payload = _json.dumps(roads, separators=(',', ':'))
    _dataset_roads_cache[dataset] = payload
    print(f"  [{dataset}] road coloring cached.")
    return payload


@app.route("/api/forecast/roads")
def forecast_roads():
    """hudson_roads.geojson recolored by forecast segment risk."""
    payload = _build_roads_for_dataset('forecast')
    if payload is None:
        return jsonify({"type": "FeatureCollection", "features": [],
                        "error": "Forecast data unavailable"}), 503
    from flask import Response as _Resp
    return _Resp(payload, mimetype='application/json')


@app.route("/api/historical/roads")
def historical_roads():
    """hudson_roads.geojson recolored by historical (Ida) segment risk."""
    payload = _build_roads_for_dataset('historical')
    if payload is None:
        return jsonify({"type": "FeatureCollection", "features": [],
                        "error": "Historical data unavailable"}), 503
    from flask import Response as _Resp
    return _Resp(payload, mimetype='application/json')


def _buildings_for_dataset(dataset: str):
    """Shared implementation of forecast/historical building coloring."""
    import json as _json
    segs = _segments_for(dataset)
    if _buildings_index is None or not segs or not HAS_RASTERIO:
        return jsonify({"type": "FeatureCollection", "features": []})

    try:
        west  = float(request.args.get("west"))
        south = float(request.args.get("south"))
        east  = float(request.args.get("east"))
        north = float(request.args.get("north"))
    except (TypeError, ValueError):
        abort(400, "west/south/east/north required")

    if (north - south) > 0.35 or (east - west) > 0.45:
        abort(400, "Bbox too large")

    _build_seg_index(dataset)

    cell_x_min = int(west  / CELL_SIZE) - 1
    cell_x_max = int(east  / CELL_SIZE) + 1
    cell_y_min = int(south / CELL_SIZE) - 1
    cell_y_max = int(north / CELL_SIZE) + 1

    candidates = []
    for cx in range(cell_x_min, cell_x_max + 1):
        for cy in range(cell_y_min, cell_y_max + 1):
            key = f"{cx}_{cy}"
            if key in _buildings_index:
                candidates.extend(_buildings_index[key])

    in_bbox = [b for b in candidates
               if west <= b['cx'] <= east and south <= b['cy'] <= north][:400]

    features = []
    for bldg in in_bbox:
        cx, cy = bldg['cx'], bldg['cy']
        easting, northing = transformer_to_utm.transform(cx, cy)
        seg, _ = _nearest_segment(dataset, easting, northing)
        max_risk = seg.get('max_risk') if seg else None
        eta_hour = seg.get('eta_hour') if seg else None
        level    = _forecast_level(max_risk)
        score    = (min(1.0, max(0.0, max_risk / _FORECAST_MAX_RISK))
                    if max_risk is not None else 0.0)
        color    = FORECAST_RISK_COLORS.get(level, '#334155')

        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [bldg['ring']]},
            "properties": {
                "pin": bldg.get("pin", ""), "mun": bldg.get("mun", ""),
                "cx": cx, "cy": cy,
                "risk_score": round(score, 3),
                "risk_level": level,
                "risk_pct":   round(score * 100),
                "risk_color": color,
                "max_risk":   round(max_risk, 4) if max_risk is not None else None,
                "eta_hour":   int(eta_hour) if eta_hour is not None else None,
                "dataset":    dataset,
            }
        })

    return jsonify({
        "type": "FeatureCollection",
        "features": features,
        "count":    len(features),
    })


@app.route("/api/forecast/buildings")
def forecast_buildings():
    """Buildings colored by forecast segment risk."""
    return _buildings_for_dataset('forecast')


@app.route("/api/historical/buildings")
def historical_buildings():
    """Buildings colored by historical (Ida) segment risk."""
    return _buildings_for_dataset('historical')


@app.route("/api/historical/events")
def historical_events():
    """
    List of historical flood events currently available.
    Each event carries a dataset id (what the frontend passes in other
    /api/historical/* endpoints once per-event routing is added) and
    the base timestamp used for ETA labels.
    """
    events = []
    if _historical_segments:
        events.append({
            "id":        "ida",
            "name":      "Hurricane Ida",
            "date":      "2021-09-01",
            "dataset":   "historical",
            "segments":  len(_historical_segments),
            "description": "Remnants of Hurricane Ida dropped record rainfall "
                           "across the NYC metro on the night of 2021-09-01, "
                           "flooding highways and basements across Hudson County.",
        })
    return jsonify({"events": events, "count": len(events)})


# ── Dynamic pipeline state ─────────────────────────────────────────
_pipeline_lock   = threading.Lock()
_pipeline_status = {"state": "idle", "last_run": None, "last_result": None}

# ── Forecast pipeline state (separate from dynamic live pipeline) ───
_forecast_pipeline_lock   = threading.Lock()
_forecast_pipeline_status = {"state": "idle", "last_run": None, "last_result": None}


def _reload_forecast_segments():
    """Reload street.geojson into _forecast_segments after pipeline completes."""
    global _forecast_segments, _dataset_roads_cache
    base = os.path.dirname(__file__)
    _forecast_segments = _load_segments_geojson(
        os.path.join(base, 'street.geojson'), 'forecast'
    )
    # Rebuild the segment index and invalidate the road coloring cache
    _seg_indices.pop('forecast', None)
    _dataset_roads_cache.pop('forecast', None)
    print("  [forecast] segments reloaded after pipeline run.")


@app.route("/api/dynamic/status")
def dynamic_status():
    """Return pipeline status + file inventory."""
    status = dict(_pipeline_status)
    if HAS_DYNAMIC:
        status["inventory"] = dynamic_core.get_pipeline_status()
    else:
        status["error"] = "dynamic_core not available"
    return jsonify(status)


@app.route("/api/forecast/status")
def forecast_pipeline_status():
    """Return forecast pipeline status + file inventory."""
    status = dict(_forecast_pipeline_status)
    if HAS_DYNAMIC:
        status["inventory"] = dynamic_core.get_pipeline_status()
    else:
        status["error"] = "dynamic_core not available"
    return jsonify(status)


@app.route("/api/forecast/run", methods=["POST"])
def forecast_run():
    """
    Trigger the full 7-step 48-hour forecast pipeline in a background thread.
    Steps: static TIF → rainfall CSV → rain rasters → soil rasters
           → risk rasters → ETA → max_risk → street.geojson
    Cleans up all previous forecast outputs before starting.
    Returns immediately; poll /api/forecast/status for progress.
    """
    if not HAS_DYNAMIC:
        return jsonify({"ok": False, "error": "dynamic_core not available"}), 503

    if _forecast_pipeline_status.get("state") == "running":
        return jsonify({"ok": False, "error": "Forecast pipeline already running"}), 409

    def _run():
        global _forecast_pipeline_status
        _forecast_pipeline_status = {
            "state": "running",
            "started_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
        try:
            result = dynamic_core.run_forecast_pipeline()
            _forecast_pipeline_status = {
                "state":       "done" if result.get("ok") else "error",
                "last_run":    result.get("completed_at"),
                "last_result": result,
            }
            if result.get("ok"):
                _reload_forecast_segments()
        except Exception as e:
            _forecast_pipeline_status = {"state": "error", "error": str(e)}

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return jsonify({"ok": True, "started": True})


@app.route("/api/dynamic/hindcast", methods=["POST", "GET"])
def dynamic_hindcast():
    """
    Trigger the full hindcast pipeline for Hurricane Ida (2021-09-01).
    Steps: fetch_historical_rainfall → CSVtoRaster → soil_moisture → dynamic_core hindcast
           → compute_eta (eta_ida.tif) → max_risk_from_stack (max_risk_ida.tif)
           → street_level_stats (street_ida.geojson)
    Query params:
      event_date (default: 2021-09-01)
      threshold  (default: 0.05)
    Returns immediately; poll /api/dynamic/status for progress.
    """
    if not HAS_DYNAMIC:
        return jsonify({"ok": False, "error": "dynamic_core not available"}), 503

    if _pipeline_status.get("state") == "running":
        return jsonify({"ok": False, "error": "Pipeline already running"}), 409

    event_date = request.args.get("event_date", "2021-09-01")
    try:
        threshold = float(request.args.get("threshold", "0.05"))
    except ValueError:
        threshold = 0.05

    def _run():
        global _pipeline_status
        _pipeline_status = {
            "state": "running",
            "mode": "hindcast",
            "event_date": event_date,
            "started_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
        try:
            result = dynamic_core.run_hindcast_pipeline(
                event_date=event_date, threshold=threshold
            )
            _pipeline_status = {
                "state":       "done" if result["ok"] else "error",
                "mode":        "hindcast",
                "last_run":    result.get("completed_at"),
                "last_result": result,
            }
        except Exception as e:
            _pipeline_status = {"state": "error", "mode": "hindcast", "error": str(e)}

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return jsonify({"ok": True, "started": True, "event_date": event_date})



def dynamic_run():
    """
    Trigger a full forecast pipeline run in a background thread.
    Steps: fetch rainfall -> fetch soil -> compute risk rasters -> max_risk + ETA
    Returns immediately with {"started": true}; poll /api/dynamic/status for progress.
    """
    if not HAS_DYNAMIC:
        return jsonify({"ok": False, "error": "dynamic_core not available"}), 503

    if _pipeline_status.get("state") == "running":
        return jsonify({"ok": False, "error": "Pipeline already running"}), 409

    def _run():
        global _pipeline_status
        _pipeline_status = {"state": "running", "started_at": __import__("datetime").datetime.utcnow().isoformat()}
        try:
            result = dynamic_core.run_forecast_pipeline()
            _pipeline_status = {
                "state":      "done" if result["ok"] else "error",
                "last_run":   result.get("completed_at"),
                "last_result": result,
            }
        except Exception as e:
            _pipeline_status = {"state": "error", "error": str(e)}

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return jsonify({"ok": True, "started": True})


# ── Live weather cache (refreshed every 10 min) ──────────────────
_weather_cache = {"rain_mm": 0.0, "soil": 0.40, "fetched_at": 0}
_WEATHER_TTL = 600  # seconds

def _get_live_weather():
    """Fetch current precipitation + soil moisture from Open-Meteo. Cached 10 min."""
    import time as _time
    now = _time.time()
    if now - _weather_cache["fetched_at"] < _WEATHER_TTL:
        return _weather_cache
    try:
        import urllib.request, urllib.parse, json as _json, datetime as _dt
        params = urllib.parse.urlencode({
            "latitude": 40.73, "longitude": -74.08,
            "hourly": "precipitation,soil_moisture_0_to_1cm",
            "forecast_days": 1, "timezone": "UTC",
        })
        url = "https://api.open-meteo.com/v1/forecast?" + params
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = _json.loads(resp.read())
        now_hour = _dt.datetime.utcnow().strftime("%Y-%m-%dT%H:00")
        times = data["hourly"]["time"]
        idx = times.index(now_hour) if now_hour in times else 0
        rain = float(data["hourly"]["precipitation"][idx] or 0)
        soil_raw = data["hourly"]["soil_moisture_0_to_1cm"][idx]
        soil = float(soil_raw) if soil_raw is not None else 0.40
        soil_norm = min(1.0, soil / 0.50)
        _weather_cache.update({
            "rain_mm": rain, "soil": soil_norm,
            "fetched_at": now, "hour": now_hour, "source": "open-meteo",
        })
        print(f"  [weather] rain={rain}mm/hr  soil={soil_norm:.2f}  @ {now_hour}")
    except Exception as e:
        print(f"  [weather] fetch failed: {e}")
        if _weather_cache["fetched_at"] == 0:
            _weather_cache.update({"rain_mm": 0.0, "soil": 0.40,
                                   "fetched_at": _time.time(), "source": "default"})
    return _weather_cache


@app.route("/api/dynamic/risk")
def dynamic_risk_point():
    """
    LIVE dynamic flood risk at a lat/lng.
    Combines static vulnerability TIF with real-time Open-Meteo weather.
    Formula: dynamic_risk = static_fv * (0.6 * rain_factor + 0.4 * soil_norm)
    Always reflects current conditions — no pipeline run needed.
    """
    try:
        lat = float(request.args.get("lat"))
        lng = float(request.args.get("lng"))
    except (TypeError, ValueError):
        abort(400, "lat and lng required")

    # Static FV at this point
    raw_fv   = sample_raster_at_point(lat, lng)
    static_fv = normalize_risk(raw_fv) or mock_risk_for_point(lat, lng)

    # Live weather
    wx          = _get_live_weather()
    rain_mm     = wx["rain_mm"]
    soil_norm   = wx["soil"]
    MAX_RAIN    = 75.0
    rain_factor = min(1.0, rain_mm / MAX_RAIN)

    # Dynamic risk formula (same as dynamic_core.py)
    dynamic_score = static_fv * (0.6 * rain_factor + 0.4 * soil_norm)
    dynamic_score = round(min(1.0, max(0.0, dynamic_score)), 4)
    level = risk_to_level(dynamic_score)

    depth_cm = round(dynamic_score * 120, 1)
    depth_labels = {
        "none": "No flooding expected", "low": "Minor puddles possible",
        "moderate": "Shallow street flooding", "high": "Roads may be impassable",
        "very_high": "Severe flooding risk",
    }

    return jsonify({
        "lat": lat, "lng": lng,
        "risk_score": dynamic_score,
        "risk_level": level,
        "risk_pct":   round(dynamic_score * 100),
        "depth": {"cm": f"{depth_cm} cm", "label": depth_labels.get(level, "")},
        "in_bounds": True,
        "source": "dynamic_live",
        "weather": {
            "rain_mm":     rain_mm,
            "rain_factor": round(rain_factor, 3),
            "soil_norm":   round(soil_norm, 3),
            "hour":        wx.get("hour", ""),
        },
        "static_fv": round(static_fv, 4),
    })


@app.route("/api/dynamic/weather")
def dynamic_weather():
    """Current live weather used for dynamic risk computation."""
    return jsonify(_get_live_weather())

@app.route("/api/dynamic/tiles/<int:z>/<int:x>/<int:y>.png")
def dynamic_tiles(z, x, y):
    """
    Serve the current-hour dynamic risk raster as colored map tiles.
    Falls back to static vulnerability tiles if no dynamic raster is ready.
    """
    if not HAS_DYNAMIC or not HAS_PIL or not HAS_RASTERIO:
        # Fall back to static tiles
        return tiles(z, x, y)

    import dynamic_core as _dc, glob, os as _os
    folder  = _dc._abs("data_dynamic_processed/dynamic_risk/forecast")
    files   = sorted(glob.glob(_os.path.join(folder, "risk_*.tif")))
    dyn_files = [f for f in files if "max_risk" not in f and "eta" not in f]

    if not dyn_files:
        return tiles(z, x, y)

    # Use most recent risk TIF
    tif_path = dyn_files[-1]

    try:
        west, south, east, north = tile_to_bbox(z, x, y)
        TILE_SIZE = 256
        img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
        pixels = img.load()

        with rasterio.open(tif_path) as src:
            nodata   = src.nodata
            overview = src.read(1, out_shape=(TILE_SIZE, TILE_SIZE),
                                resampling=rasterio.enums.Resampling.bilinear)
            b = src.bounds
            w_r, s_r, e_r, n_r = b.left, b.bottom, b.right, b.top

            # Map tile pixels to raster pixels
            for py in range(TILE_SIZE):
                lat = north - (north - south) * py / TILE_SIZE
                for px in range(TILE_SIZE):
                    lng = west + (east - west) * px / TILE_SIZE
                    col = int((lng - w_r) / (e_r - w_r) * TILE_SIZE)
                    row = int((n_r - lat) / (n_r - s_r) * TILE_SIZE)
                    if 0 <= row < TILE_SIZE and 0 <= col < TILE_SIZE:
                        val = overview[row, col]
                        if nodata is None or val != nodata:
                            score = max(0.0, min(1.0, float(val)))
                            r2, g2, b2, a2 = risk_to_rgba(score)
                            pixels[px, py] = (r2, g2, b2, a2)

        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        from flask import send_file
        return send_file(buf, mimetype="image/png")

    except Exception as e:
        return tiles(z, x, y)


@app.route("/api/dynamic/roads")
def get_dynamic_roads():
    """
    Roads GeoJSON recolored by LIVE dynamic risk = static_fv * weather_factor.
    Called by the frontend in dynamic mode instead of /api/roads.
    """
    import json as _json

    # Get live weather factor
    wx                  = _get_live_weather()
    rain_factor         = min(1.0, wx["rain_mm"] / 75.0)
    soil_norm           = wx["soil"]
    weather_multiplier  = 0.6 * rain_factor + 0.4 * soil_norm

    geojson_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__), '..', 'public', 'hudson_roads.geojson')
    )
    if not os.path.exists(geojson_path):
        abort(404, "Roads GeoJSON not found")

    with open(geojson_path) as f:
        roads = _json.load(f)

    RISK_COLORS_MAP = {
        "none": "#22c55e", "low": "#84cc16", "moderate": "#eab308",
        "high": "#f97316", "very_high": "#ef4444",
    }
    ROAD_WEIGHTS = {
        'S1100': 3.5, 'S1200': 2.5, 'S1400': 1.5, 'S1630': 1.5,
    }

    for feat in roads['features']:
        coords = feat['geometry']['coordinates']
        if not coords or not coords[0]:
            continue
        line     = coords[0]
        lng_c, lat_c = line[len(line) // 2][0], line[len(line) // 2][1]
        raw      = sample_raster_at_point(lat_c, lng_c)
        static_fv = normalize_risk(raw) or 0.1
        dyn_score = round(min(1.0, static_fv * weather_multiplier), 3)
        level     = risk_to_level(dyn_score)
        rc        = feat['properties'].get('roadclass', 'S1400')
        feat['properties'].update({
            'risk_score': dyn_score,
            'risk_level': level,
            'risk_pct':   round(dyn_score * 100),
            'risk_color': RISK_COLORS_MAP.get(level, '#334155'),
            'weight':     ROAD_WEIGHTS.get(rc, 1.5),
        })

    result = dict(roads)
    result['weather'] = {
        "rain_mm": wx["rain_mm"], "soil_norm": round(soil_norm, 3),
        "weather_multiplier": round(weather_multiplier, 3),
    }
    from flask import Response as _Resp
    return _Resp(_json.dumps(result, separators=(',',':')), mimetype='application/json')


@app.route("/api/dynamic/buildings")
def get_dynamic_buildings():
    """
    Buildings in bbox colored by LIVE dynamic risk.
    """
    import json as _json

    if _buildings_index is None:
        return jsonify({"type":"FeatureCollection","features":[]})

    try:
        west  = float(request.args.get("west"))
        south = float(request.args.get("south"))
        east  = float(request.args.get("east"))
        north = float(request.args.get("north"))
    except (TypeError, ValueError):
        abort(400, "west/south/east/north required")

    if (north - south) > 0.35 or (east - west) > 0.45:
        abort(400, "Bbox too large")

    # Live weather
    wx                 = _get_live_weather()
    rain_factor        = min(1.0, wx["rain_mm"] / 75.0)
    soil_norm          = wx["soil"]
    weather_multiplier = 0.6 * rain_factor + 0.4 * soil_norm

    cell_x_min = int(west  / CELL_SIZE) - 1
    cell_x_max = int(east  / CELL_SIZE) + 1
    cell_y_min = int(south / CELL_SIZE) - 1
    cell_y_max = int(north / CELL_SIZE) + 1

    candidates = []
    for cx in range(cell_x_min, cell_x_max + 1):
        for cy in range(cell_y_min, cell_y_max + 1):
            key = f"{cx}_{cy}"
            if key in _buildings_index:
                candidates.extend(_buildings_index[key])

    in_bbox = [b for b in candidates
               if west <= b['cx'] <= east and south <= b['cy'] <= north][:400]

    RISK_COLORS_MAP = {
        "none": "#22c55e", "low": "#84cc16", "moderate": "#eab308",
        "high": "#f97316", "very_high": "#ef4444",
    }

    features = []
    for bldg in in_bbox:
        cx, cy = bldg['cx'], bldg['cy']
        raw       = sample_raster_at_point(cy, cx)
        static_fv = normalize_risk(raw) or 0.1
        dyn_score = round(min(1.0, static_fv * weather_multiplier), 3)
        level     = risk_to_level(dyn_score)
        color     = RISK_COLORS_MAP.get(level, '#334155')

        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [bldg['ring']]},
            "properties": {
                "pin": bldg.get("pin",""), "mun": bldg.get("mun",""),
                "cx": cx, "cy": cy,
                "risk_score": dyn_score, "risk_level": level,
                "risk_pct": round(dyn_score * 100), "risk_color": color,
            }
        })

    return jsonify({
        "type": "FeatureCollection",
        "features": features,
        "count": len(features),
        "weather_multiplier": round(weather_multiplier, 3),
    })


# ── Rainfall scenario definitions ─────────────────────────────
RAINFALL_SCENARIOS = {
    "none":    {"rain_mm": 0.0,  "soil": 0.30, "label": "No Rain",      "desc": "Dry conditions"},
    "light":   {"rain_mm": 5.0,  "soil": 0.40, "label": "Light Rain",   "desc": "5 mm/hr"},
    "heavy":   {"rain_mm": 25.0, "soil": 0.55, "label": "Heavy Rain",   "desc": "25 mm/hr"},
    "extreme": {"rain_mm": 60.0, "soil": 0.70, "label": "Extreme Rain", "desc": "60 mm/hr"},
}
MAX_RAIN_SCENARIO = 75.0

def _scenario_risk(static_fv, scenario_id):
    """Compute risk score for a given static FV value under a rainfall scenario."""
    sc   = RAINFALL_SCENARIOS.get(scenario_id, RAINFALL_SCENARIOS["none"])
    rf   = min(1.0, sc["rain_mm"] / MAX_RAIN_SCENARIO)
    soil = sc["soil"]
    return min(1.0, max(0.0, static_fv * (0.6 * rf + 0.4 * soil)))


@app.route("/api/scenarios")
def get_scenarios():
    """List available rainfall scenarios."""
    return jsonify(RAINFALL_SCENARIOS)


@app.route("/api/scenario/risk")
def scenario_risk_point():
    """
    Risk at a point under a rainfall scenario.
    GET /api/scenario/risk?lat=40.73&lng=-74.07&scenario=heavy
    """
    try:
        lat      = float(request.args.get("lat"))
        lng      = float(request.args.get("lng"))
        scenario = request.args.get("scenario", "none")
    except (TypeError, ValueError):
        abort(400, "lat and lng required")

    if scenario not in RAINFALL_SCENARIOS:
        abort(400, f"Unknown scenario. Choose from: {list(RAINFALL_SCENARIOS.keys())}")

    raw_fv    = sample_raster_at_point(lat, lng)
    static_fv = normalize_risk(raw_fv) or mock_risk_for_point(lat, lng)
    score     = _scenario_risk(static_fv, scenario)
    level     = risk_to_level(score)
    sc        = RAINFALL_SCENARIOS[scenario]

    depth_cm = round(score * 120, 1)
    depth_labels = {
        "none": "No flooding expected", "low": "Minor puddles possible",
        "moderate": "Shallow street flooding", "high": "Roads may be impassable",
        "very_high": "Severe flooding risk",
    }

    return jsonify({
        "lat": lat, "lng": lng,
        "scenario": scenario,
        "scenario_label": sc["label"],
        "rain_mm": sc["rain_mm"],
        "risk_score": round(score, 4),
        "risk_level": level,
        "risk_pct":   round(score * 100),
        "depth": {"cm": f"{depth_cm} cm", "label": depth_labels.get(level, "")},
        "in_bounds": True,
        "source": "scenario",
        "static_fv": round(static_fv, 4),
    })


@app.route("/api/scenario/roads")
def scenario_roads():
    """Roads colored under a rainfall scenario."""
    import json as _json
    scenario = request.args.get("scenario", "none")
    if scenario not in RAINFALL_SCENARIOS:
        abort(400, "Unknown scenario")

    geojson_path = os.path.normpath(
        os.path.join(os.path.dirname(__file__), '..', 'public', 'hudson_roads.geojson')
    )
    if not os.path.exists(geojson_path):
        abort(404, "Roads GeoJSON not found")

    with open(geojson_path) as f:
        roads = _json.load(f)

    RISK_COLORS_MAP = {
        "none": "#22c55e", "low": "#84cc16", "moderate": "#eab308",
        "high": "#f97316", "very_high": "#ef4444",
    }
    ROAD_WEIGHTS = {'S1100': 3.5, 'S1200': 2.5, 'S1400': 1.5, 'S1630': 1.5}

    for feat in roads['features']:
        coords = feat['geometry']['coordinates']
        if not coords or not coords[0]: continue
        line      = coords[0]
        lng_c, lat_c = line[len(line) // 2][0], line[len(line) // 2][1]
        raw       = sample_raster_at_point(lat_c, lng_c)
        static_fv = normalize_risk(raw) or 0.1
        score     = _scenario_risk(static_fv, scenario)
        level     = risk_to_level(score)
        rc        = feat['properties'].get('roadclass', 'S1400')
        feat['properties'].update({
            'risk_score': round(score, 3), 'risk_level': level,
            'risk_pct': round(score * 100),
            'risk_color': RISK_COLORS_MAP.get(level, '#334155'),
            'weight': ROAD_WEIGHTS.get(rc, 1.5),
        })

    from flask import Response as _Resp
    return _Resp(_json.dumps(roads, separators=(',', ':')), mimetype='application/json')


@app.route("/api/scenario/buildings")
def scenario_buildings():
    """Buildings in bbox colored under a rainfall scenario."""
    import json as _json
    if _buildings_index is None:
        return jsonify({"type":"FeatureCollection","features":[]})

    try:
        west  = float(request.args.get("west"))
        south = float(request.args.get("south"))
        east  = float(request.args.get("east"))
        north = float(request.args.get("north"))
        scenario = request.args.get("scenario", "none")
    except (TypeError, ValueError):
        abort(400, "Parameters required")

    if scenario not in RAINFALL_SCENARIOS:
        abort(400, "Unknown scenario")
    if (north - south) > 0.35 or (east - west) > 0.45:
        abort(400, "Bbox too large")

    cell_x_min = int(west  / CELL_SIZE) - 1
    cell_x_max = int(east  / CELL_SIZE) + 1
    cell_y_min = int(south / CELL_SIZE) - 1
    cell_y_max = int(north / CELL_SIZE) + 1

    candidates = []
    for cx in range(cell_x_min, cell_x_max + 1):
        for cy in range(cell_y_min, cell_y_max + 1):
            key = f"{cx}_{cy}"
            if key in _buildings_index:
                candidates.extend(_buildings_index[key])

    in_bbox = [b for b in candidates
               if west <= b['cx'] <= east and south <= b['cy'] <= north][:400]

    RISK_COLORS_MAP = {
        "none": "#22c55e", "low": "#84cc16", "moderate": "#eab308",
        "high": "#f97316", "very_high": "#ef4444",
    }
    features = []
    for bldg in in_bbox:
        cx, cy    = bldg['cx'], bldg['cy']
        raw       = sample_raster_at_point(cy, cx)
        static_fv = normalize_risk(raw) or 0.1
        score     = _scenario_risk(static_fv, scenario)
        level     = risk_to_level(score)
        color     = RISK_COLORS_MAP.get(level, '#334155')
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [bldg['ring']]},
            "properties": {
                "pin": bldg.get("pin",""), "mun": bldg.get("mun",""),
                "cx": cx, "cy": cy,
                "risk_score": round(score, 3), "risk_level": level,
                "risk_pct": round(score * 100), "risk_color": color,
            }
        })

    return jsonify({
        "type": "FeatureCollection", "features": features,
        "scenario": scenario, "count": len(features),
    })

if __name__ == "__main__":
    print("\n" + "="*55)
    print("  Hudson County Flood Risk Tile Server")
    print("="*55)
    print(f"  TIF path : {TIF_PATH}")
    print(f"  TIF exists: {os.path.exists(TIF_PATH)}")
    print(f"  Rasterio : {'✓' if HAS_RASTERIO else '✗ (install: pip install rasterio)'}")
    print(f"  Pillow   : {'✓' if HAS_PIL else '✗ (install: pip install pillow)'}")
    print(f"  Mode     : {'LIVE GeoTIFF' if raster_loaded else 'MOCK DATA'}")
    print("="*55)
    print("  Endpoints:")
    print("  GET http://localhost:5000/api/health")
    print("  GET http://localhost:5000/api/risk?lat=40.73&lng=-74.07")
    print("  GET http://localhost:5000/api/tiles/{z}/{x}/{y}.png")
    print("  GET http://localhost:5000/api/dynamic/status")
    print("  GET  http://localhost:5000/api/forecast/status")
    print("  POST http://localhost:5000/api/forecast/run  (48-hour forecast pipeline)")
    print("  POST http://localhost:5000/api/dynamic/hindcast?event_date=2021-09-01")
    print("  GET http://localhost:5000/api/hindcast/street-risk?lat=40.73&lng=-74.07")
    print("  GET http://localhost:5000/api/dynamic/risk?lat=40.73&lng=-74.07")
    print("  GET http://localhost:5000/api/dynamic/tiles/{z}/{x}/{y}.png")
    print("="*55 + "\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
