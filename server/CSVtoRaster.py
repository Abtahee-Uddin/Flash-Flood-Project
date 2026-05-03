import os
import pandas as pd
import numpy as np
import rasterio

# ===== CONFIGURATION =====
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(BASE_DIR)

STATIC_PATH = "data_static/static_fv_10m.tif"
FORECAST_FOLDER = "data_dynamic_raw/rainfall/forecast/"

# ===== FIND LATEST FORECAST CSV =====
csv_files = [f for f in os.listdir(FORECAST_FOLDER) if f.endswith(".csv")]

if not csv_files:
    raise FileNotFoundError("No forecast CSV files found.")

# Pick latest file based on filename timestamp
latest_csv = sorted(csv_files)[-1]
CSV_PATH = os.path.join(FORECAST_FOLDER, latest_csv)

print(f"Using forecast file: {CSV_PATH}")

# ===== CLEAN OLD RASTERS (optional) =====
for f in os.listdir(FORECAST_FOLDER):
    if f.endswith(".tif") and f.startswith("forecast_"):
        os.remove(os.path.join(FORECAST_FOLDER, f))

# ===== LOAD CSV =====
df = pd.read_csv(CSV_PATH)
df["time"] = pd.to_datetime(df["time"])

# ===== LOAD STATIC RASTER =====
with rasterio.open(STATIC_PATH) as ref:
    profile = ref.profile
    width, height = ref.width, ref.height
    static_data = ref.read(1)
    static_nodata = ref.nodata

# Mask for valid region
valid_mask = (static_data != static_nodata)

# Update profile
profile.update(dtype="float32", count=1, compress="lzw", nodata=static_nodata)

# ===== PROCESS EACH HOUR =====
for _, row in df.iterrows():
    rain_val = row["precip_mm"]
    timestamp = row["time"].strftime("%Y%m%d_%H")

    data = np.full((height, width), rain_val, dtype="float32")
    data[~valid_mask] = static_nodata

    out_path = os.path.join(FORECAST_FOLDER, f"rain_{timestamp}.tif")

    with rasterio.open(out_path, "w", **profile) as dst:
        dst.write(data, 1)

    print(f"Saved {out_path}")

print("All forecast rainfall rasters created successfully.")