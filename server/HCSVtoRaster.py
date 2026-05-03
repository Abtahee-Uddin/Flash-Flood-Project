import os
import pandas as pd
import numpy as np
import rasterio
 
# ===== CONFIGURATION =====
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(BASE_DIR)  # change working directory to project root
 
# Event date (same as the folder where rainfall CSV is stored)
EVENT_DATE = "2021-09-01"
 
# Paths (relative to project root)
STATIC_PATH = "data_static/static_fv_10m.tif"
RAIN_FOLDER = f"data_dynamic_raw/rainfall/historical/{EVENT_DATE}/"
CSV_PATH = os.path.join(RAIN_FOLDER, "rain_hourly.csv")
 
# Ensure output folder exists
os.makedirs(RAIN_FOLDER, exist_ok=True)
 
# Clean old rainfall rasters (optional – removes any existing rain_*.tif in this folder)
for f in os.listdir(RAIN_FOLDER):
    if f.endswith(".tif") and f.startswith("rain_"):
        os.remove(os.path.join(RAIN_FOLDER, f))
 
# Load rainfall CSV
df = pd.read_csv(CSV_PATH)
df["time"] = pd.to_datetime(df["time"])
 
# Load static raster to get georeferencing and nodata value
with rasterio.open(STATIC_PATH) as ref:
    profile = ref.profile
    width, height = ref.width, ref.height
    static_data = ref.read(1)
    static_nodata = ref.nodata  # should be -3.4028235e+38
 
# Create a mask where static has valid data (inside county)
valid_mask = (static_data != static_nodata)
 
# Update profile for rainfall rasters (use same nodata as static)
profile.update(dtype="float32", count=1, compress="lzw", nodata=static_nodata)
 
# Process each hour
for _, row in df.iterrows():
    rain_val = row["precip_mm"]
    timestamp = row["time"].strftime("%Y%m%d_%H")
 
    # Create array filled with rainfall value
    data = np.full((height, width), rain_val, dtype="float32")
 
    # Set pixels outside the county to nodata (masking)
    data[~valid_mask] = static_nodata
 
    # Save raster
    out_path = os.path.join(RAIN_FOLDER, f"rain_{timestamp}.tif")
    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)
 
    print(f"Saved {out_path}")
 
print("All rainfall rasters created successfully.")