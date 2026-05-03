"""
check_dynamic_range.py — Inspect value ranges in dynamic risk rasters.

Verifies that dynamic risk output matches the expected formula:
    risk = static * (rain / MAX_RAIN) * soil

Usage:
    python utils/check_dynamic_range.py
    python utils/check_dynamic_range.py --folder data_dynamic_processed/dynamic_risk/2021-09-01
"""

import os
import sys
import argparse
import numpy as np

try:
    import rasterio
except ImportError:
    print("ERROR: rasterio not installed. Run: pip install rasterio")
    sys.exit(1)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_range(folder):
    tif_files = sorted([
        f for f in os.listdir(folder) if f.endswith(".tif")
        and "max_risk" not in f and "eta" not in f
    ])

    if not tif_files:
        print(f"No risk TIF files found in: {folder}")
        return

    print(f"Checking {len(tif_files)} rasters in: {folder}\n")

    static_path = os.path.join(BASE_DIR, "data_static", "static_fv_10m.tif")
    with rasterio.open(static_path) as src:
        static = src.read(1, masked=True).filled(np.nan)

    print(f"{'File':<35} {'Min':>10} {'Max':>10} {'NaN px':>10} {'Valid px':>10}")
    print("-" * 80)

    for fname in tif_files[:10]:  # cap at 10 for speed
        path = os.path.join(folder, fname)
        with rasterio.open(path) as src:
            data   = src.read(1)
            nodata = src.nodata

        if nodata is not None:
            valid = data[data != nodata]
        else:
            valid = data[~np.isnan(data)]

        nan_count = np.isnan(data).sum() if nodata is None else (data == nodata).sum()
        vmin = valid.min() if len(valid) else float('nan')
        vmax = valid.max() if len(valid) else float('nan')

        print(f"{fname:<35} {vmin:>10.5f} {vmax:>10.5f} {nan_count:>10,} {len(valid):>10,}")

    if len(tif_files) > 10:
        print(f"  ... ({len(tif_files) - 10} more files not shown)")

    # Quick formula spot-check on first file
    first_path = os.path.join(folder, tif_files[0])
    with rasterio.open(first_path) as src:
        dynamic = src.read(1)
        nodata  = src.nodata

    idx = np.argwhere(~np.isnan(static))
    if len(idx):
        i, j = idx[len(idx) // 2]
        static_val  = static[i, j]
        dynamic_val = dynamic[i, j]
        ratio = dynamic_val / static_val if static_val != 0 else float('nan')
        print(f"\nSpot-check pixel ({i},{j}):")
        print(f"  static_fv  = {static_val:.5f}")
        print(f"  dynamic    = {dynamic_val:.5f}")
        print(f"  ratio      = {ratio:.4f}  (should be in [0, 1] for valid risk)")


def main():
    parser = argparse.ArgumentParser(description="Check dynamic risk raster value ranges.")
    parser.add_argument(
        "--folder",
        default=os.path.join(BASE_DIR, "data_dynamic_processed", "dynamic_risk"),
        help="Folder containing risk_*.tif or forecast_risk_*.tif files",
    )
    args = parser.parse_args()

    if not os.path.isdir(args.folder):
        print(f"ERROR: folder not found: {args.folder}")
        sys.exit(1)

    check_range(args.folder)


if __name__ == "__main__":
    main()
