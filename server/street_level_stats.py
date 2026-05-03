"""
street_level_stats.py — Street-level risk aggregation
======================================================
Reads eta.tif and max_risk.tif and annotates each road segment in
hudson_roads.geojson with:
  max_risk  — pixel-wise maximum of max_risk raster along the segment
  eta_hour  — earliest (minimum) hour from the ETA raster along the segment

Uses only rasterio + geopandas (already required by the project).
No rasterstats, fiona, or osmnx needed.
"""

import os
import argparse
import numpy as np
import rasterio
from rasterio.transform import rowcol
import geopandas as gpd

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_raster(path):
    """Return (data array, transform, nodata, epsg) with data fully in memory."""
    with rasterio.open(path) as src:
        data      = src.read(1)
        transform = src.transform
        nodata    = src.nodata
        epsg      = src.crs.to_epsg()
    return data, transform, nodata, epsg


def _sample_segment(geom, data, transform, nodata, stat='max', interval_m=50):
    """
    Interpolate points along a LineString at ~interval_m metre spacing,
    sample the raster array at each point, and return the requested stat
    (max or min) over valid (non-nodata, non-nan) samples.
    Returns None if no valid samples are found.
    """
    length  = geom.length
    n_pts   = max(2, int(length / interval_m))
    samples = []

    for i in range(n_pts + 1):
        pt  = geom.interpolate(i / n_pts, normalized=True)
        try:
            r, c = rowcol(transform, pt.x, pt.y)
            if 0 <= r < data.shape[0] and 0 <= c < data.shape[1]:
                v = data[r, c]
                if nodata is None or (not np.isnan(v) and v != nodata):
                    samples.append(float(v))
        except Exception:
            pass

    if not samples:
        return None
    return float(np.max(samples)) if stat == 'max' else float(np.min(samples))


def street_level_stats(eta_raster, max_risk_raster, place, out_geojson):
    """
    Annotate hudson_roads.geojson with max_risk and eta_hour from the
    forecast rasters and write the result to out_geojson.

    Parameters
    ----------
    eta_raster      : path to eta.tif (hours until risk >= threshold)
    max_risk_raster : path to max_risk.tif (pixel-wise peak risk)
    place           : unused — kept for CLI compatibility with the old signature
    out_geojson     : output path for the annotated GeoJSON
    """
    roads_path = os.path.join(_PROJECT_ROOT, "public", "hudson_roads.geojson")
    if not os.path.exists(roads_path):
        raise FileNotFoundError(
            f"hudson_roads.geojson not found at {roads_path}\n"
            f"Expected location: <project_root>/public/hudson_roads.geojson"
        )

    print(f"  [step 7] Loading {roads_path}…")
    gdf = gpd.read_file(roads_path)
    n   = len(gdf)
    print(f"  [step 7] {n:,} road segments loaded")

    # Load both rasters fully into memory
    print(f"  [step 7] Loading rasters…")
    eta_data,  eta_tf,  eta_nd,  eta_epsg  = _load_raster(eta_raster)
    risk_data, risk_tf, risk_nd, risk_epsg = _load_raster(max_risk_raster)

    # Reproject roads to match the raster CRS (EPSG:26918 UTM)
    gdf_utm = gdf.to_crs(epsg=eta_epsg)

    print(f"  [step 7] Sampling rasters along {n:,} segments…")
    eta_vals      = []
    max_risk_vals = []

    for idx, geom in enumerate(gdf_utm.geometry):
        if idx % 2000 == 0:
            print(f"  [step 7]   {idx:,} / {n:,}…")
        if geom is None or geom.is_empty:
            eta_vals.append(None)
            max_risk_vals.append(None)
            continue

        eta_vals.append(     _sample_segment(geom, eta_data,  eta_tf,  eta_nd,  stat='min'))
        max_risk_vals.append(_sample_segment(geom, risk_data, risk_tf, risk_nd, stat='max'))

    gdf['eta_hour'] = eta_vals
    gdf['max_risk'] = max_risk_vals

    os.makedirs(os.path.dirname(os.path.abspath(out_geojson)), exist_ok=True)
    gdf.to_file(out_geojson, driver="GeoJSON")
    print(f"[OK] Street-level data saved to {out_geojson}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Annotate road segments with forecast max_risk and eta_hour'
    )
    parser.add_argument('--eta',      required=True, help='ETA raster file (eta.tif)')
    parser.add_argument('--max_risk', required=True, help='Max-risk raster file (max_risk.tif)')
    parser.add_argument('--place',    default='Hudson County, New Jersey, USA',
                        help='Unused — kept for backward compatibility')
    parser.add_argument('--out',      default='street.geojson',
                        help='Output GeoJSON file (default: street.geojson)')
    args = parser.parse_args()
    street_level_stats(args.eta, args.max_risk, args.place, args.out)
