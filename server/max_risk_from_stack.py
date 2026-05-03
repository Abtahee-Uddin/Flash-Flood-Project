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

def max_risk_from_stack(risk_folder, out_file):
    folder = _resolve(risk_folder)
    if not folder.is_dir():
        print(f"[ERROR] Risk folder not found: {folder}")
        print(f"   (Looked in project root: {_PROJECT_ROOT})")
        return

    risk_files = sorted(folder.glob('*.tif'))
    if not risk_files:
        print(f"[ERROR] No .tif files found in: {folder}")
        return

    with rasterio.open(risk_files[0]) as src:
        profile  = src.profile
        max_data = src.read(1).copy()
        nodata   = src.nodata

    for f in risk_files[1:]:
        with rasterio.open(f) as src:
            data = src.read(1)
            # Update max where data > current max and data is not NoData
            mask = (data != nodata) & (data > max_data)
            max_data[mask] = data[mask]

    with rasterio.open(out_file, 'w', **profile) as dst:
        dst.write(max_data.astype(np.float32), 1)
    print(f"[OK] Max risk raster saved to {out_file}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--risk_folder', required=True,
                        help='Folder containing risk_*.tif files')
    parser.add_argument('--out', default='max_risk.tif',
                        help='Output max risk raster filename')
    args = parser.parse_args()
    max_risk_from_stack(args.risk_folder, args.out)
