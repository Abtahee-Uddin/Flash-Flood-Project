import os
import rasterio
import numpy as np
from pathlib import Path
import argparse

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def _resolve(path):
    """Resolve relative paths against the project root, not cwd."""
    p = Path(path)
    if p.is_absolute():
        return p
    candidate = Path(_PROJECT_ROOT) / p
    if candidate.exists():
        return candidate
    return p

def compute_eta(risk_folder, threshold, out_file):
    folder = _resolve(risk_folder)
    if not folder.is_dir():
        print(f"[ERROR] Risk folder not found: {folder}")
        print(f"   (Looked in project root: {_PROJECT_ROOT})")
        return

    risk_files = sorted(folder.glob('*.tif'))
    if not risk_files:
        print(f"[ERROR] No .tif files found in: {folder}")
        return

    eta     = None
    profile = None
    for hour_idx, rf in enumerate(risk_files, start=1):
        with rasterio.open(rf) as src:
            risk = src.read(1)
            if eta is None:
                eta = np.full_like(risk, np.nan, dtype=np.float32)
                profile = src.profile
                profile.update(dtype=np.float32, nodata=np.nan)
            # Mark pixels where risk >= threshold and not already set
            mask = (risk >= threshold) & np.isnan(eta)
            eta[mask] = hour_idx

    if eta is not None:
        with rasterio.open(out_file, 'w', **profile) as dst:
            dst.write(eta, 1)
        print(f"[OK] ETA raster saved to {out_file}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--risk_folder', required=True,
                        help='Folder containing risk_*.tif files')
    parser.add_argument('--threshold', type=float, default=0.05,
                        help='Risk threshold (default 0.05)')
    parser.add_argument('--out', default='eta.tif',
                        help='Output ETA raster filename')
    args = parser.parse_args()
    compute_eta(args.risk_folder, args.threshold, args.out)
