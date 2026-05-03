"""
check_file_count.py — Verify expected raster counts for the pipeline.

Checks rainfall, soil, and dynamic risk folders and reports how many TIF files
are present vs the expected 48 (one per hour over 2 days).

Usage:
    python utils/check_file_count.py
    python utils/check_file_count.py --event_date 2021-09-01
"""

import os
import argparse

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPECTED = 48


def count_tifs(folder):
    if not os.path.isdir(folder):
        return 0, folder
    files = [f for f in os.listdir(folder) if f.endswith(".tif")]
    return len(files), folder


def check_counts(event_date):
    folders = {
        "Rainfall rasters": os.path.join(
            BASE_DIR, "data_dynamic_raw", "rainfall", "historical", event_date
        ),
        "Soil rasters (resampled)": os.path.join(
            BASE_DIR, "data_dynamic_raw", "soil", "historical", event_date, "resampled"
        ),
        "Dynamic risk rasters": os.path.join(
            BASE_DIR, "data_dynamic_processed", "dynamic_risk", event_date
        ),
    }

    print(f"File count check for event: {event_date}  (expected: {EXPECTED})\n")
    all_ok = True
    for label, folder in folders.items():
        count, path = count_tifs(folder)
        status = "✅" if count == EXPECTED else ("⚠️ " if count > 0 else "❌")
        print(f"  {status} {label}: {count}/{EXPECTED}")
        print(f"       {path}")
        if count != EXPECTED:
            all_ok = False

    # Also check derived outputs
    derived = {
        "ETA raster (eta_ida.tif)": os.path.join(
            BASE_DIR, "data_dynamic_processed", "dynamic_risk", event_date, "eta_ida.tif"
        ),
        "Max-risk raster (max_risk_ida.tif)": os.path.join(
            BASE_DIR, "data_dynamic_processed", "dynamic_risk", event_date, "max_risk_ida.tif"
        ),
        "Street GeoJSON (street_ida.geojson)": os.path.join(
            BASE_DIR, "street_ida.geojson"
        ),
    }
    print()
    for label, path in derived.items():
        exists = os.path.isfile(path)
        status = "✅" if exists else "❌"
        print(f"  {status} {label}")

    print()
    if all_ok:
        print("All raster counts look correct.")
    else:
        print("Some counts are off. Re-run the pipeline steps for missing files.")


def main():
    parser = argparse.ArgumentParser(description="Check pipeline file counts.")
    parser.add_argument(
        "--event_date", default="2021-09-01",
        help="Event date in YYYY-MM-DD format (default: 2021-09-01)"
    )
    args = parser.parse_args()
    check_counts(args.event_date)


if __name__ == "__main__":
    main()
