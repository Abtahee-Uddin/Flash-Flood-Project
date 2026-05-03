"""
conversion.py — Reproject street_ida.geojson to WGS84 and copy to public data folder.

Run after street_level_stats.py has produced street_ida.geojson:
    python conversion.py

Output: public/data/street_forecast.geojson (WGS84 / EPSG:4326)
"""

import os
import geopandas as gpd

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

INPUT_PATH  = os.path.join(BASE_DIR, "street_ida.geojson")
OUTPUT_DIR  = os.path.join(BASE_DIR, "public", "data")
OUTPUT_PATH = os.path.join(OUTPUT_DIR, "street_forecast.geojson")

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Load the historical GeoJSON
gdf = gpd.read_file(INPUT_PATH)

# Reproject to WGS84 (EPSG:4326) for Leaflet compatibility
gdf = gdf.to_crs("EPSG:4326")

# Save to the website data folder
gdf.to_file(OUTPUT_PATH, driver="GeoJSON")

print(f"✅ Reprojected street GeoJSON saved to {OUTPUT_PATH}")
