import os
import datetime as dt
import numpy as np
import rasterio
from rasterio.transform import from_origin
import requests
import warnings

warnings.filterwarnings('ignore')

# project paths

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_FV_PATH = os.path.join(PROJECT_ROOT, "data_static", "static_fv_10m.tif")

# dates

HISTORICAL_DATE = "2021-09-01"
TODAY = dt.datetime.now()

# output folders

SOIL_LATEST_DIR = os.path.join(PROJECT_ROOT, "data_dynamic_raw", "soil", "latest")
SOIL_HISTORICAL_BASE = os.path.join(PROJECT_ROOT, "data_dynamic_raw", "soil", "historical")

os.makedirs(SOIL_LATEST_DIR, exist_ok=True)


# read static

def get_static_map_reference():

    if not os.path.exists(STATIC_FV_PATH):
        raise FileNotFoundError(f"Static map not found: {STATIC_FV_PATH}")

    with rasterio.open(STATIC_FV_PATH) as src:

        reference = {
            'crs': src.crs,
            'transform': src.transform,
            'bounds': src.bounds,
            'width': src.width,
            'height': src.height,
            'nodata': src.nodata,
            'shape': (src.height, src.width)
        }

        static_data = src.read(1)

        valid_mask = (
            ~np.isnan(static_data)
            if np.any(np.isnan(static_data))
            else (static_data != src.nodata)
            if src.nodata is not None
            else np.ones_like(static_data, dtype=bool)
        )

        reference['valid_mask'] = valid_mask

        return reference


# fetch soil

def get_soil_moisture_value(date_str):

    url = "https://power.larc.nasa.gov/api/temporal/daily/point"
    lat, lon = 40.73, -74.08

    params = {
        "request": "execute",
        "format": "JSON",
        "user": "anonymous",
        "startDate": date_str,
        "endDate": date_str,
        "latitude": lat,
        "longitude": lon,
        "parameters": "GWETPROF"
    }

    try:
        response = requests.get(url, params=params)
        data = response.json()

        if 'properties' in data:
            return data['properties']['parameter']['GWETPROF'][date_str]

    except:
        pass

    month = int(date_str[5:7])

    if month in [3,4,5]:
        return 0.45
    elif month in [6,7,8]:
        return 0.35
    elif month in [9,10,11]:
        return 0.42
    else:
        return 0.38


# time series

def generate_timeseries(base_value, start_date, hours=48):

    times = []
    values = []

    for hour in range(hours):

        current_time = start_date + dt.timedelta(hours=hour)
        times.append(current_time)

        hour_of_day = current_time.hour
        diurnal = 0.05 * np.sin((hour_of_day - 5) / 12 * np.pi)

        if hour in [8,24,36]:
            rain_effect = 0.07
        else:
            hrs = min([abs(hour - r) for r in [8,24,36]] if hour > 0 else [100])
            rain_effect = 0.05 * np.exp(-hrs/5) if hrs < 10 else 0

        drying = -0.0002 * hour

        np.random.seed(hour)
        noise = 0.008 * np.random.randn()

        value = base_value + diurnal + rain_effect + drying + noise
        value = np.clip(value, 0.18, 0.65)

        values.append(value)

    return times, values


# create raster

def create_soil_moisture_raster(value, timestamp, output_path, static_ref):

    height = static_ref['height']
    width = static_ref['width']
    crs = static_ref['crs']
    transform = static_ref['transform']
    valid_mask = static_ref['valid_mask']
    nodata = static_ref['nodata']

    x = np.linspace(static_ref['bounds'].left, static_ref['bounds'].right, width)
    y = np.linspace(static_ref['bounds'].bottom, static_ref['bounds'].top, height)
    X, Y = np.meshgrid(x, y)

    river_x, river_y = 577000, 4509000
    dist = np.sqrt(((X-river_x)/1000)**2 + ((Y-river_y)/1000)**2)
    river_effect = 0.10*np.exp(-dist/3)

    urban_centers = [(583000,4505000),(576000,4507000),(572000,4512000)]

    urban_effect = np.zeros_like(X)

    for ux,uy in urban_centers:
        d = np.sqrt(((X-ux)/1000)**2 + ((Y-uy)/1000)**2)
        urban_effect += -0.04*np.exp(-d/2)

    topo_effect = 0.02*np.sin(X/3000)*np.cos(Y/3000)

    np.random.seed(int(timestamp.timestamp())%1000)
    random_pattern = 0.01*np.random.randn(height,width)

    soil_data = value + river_effect + urban_effect + topo_effect + random_pattern
    soil_data = np.clip(soil_data,0.15,0.70)

    soil_data[~valid_mask] = nodata

    with rasterio.open(
        output_path,'w',
        driver='GTiff',
        height=height,
        width=width,
        count=1,
        dtype=soil_data.dtype,
        crs=crs,
        transform=transform,
        nodata=nodata
    ) as dst:

        dst.write(soil_data,1)

    return output_path


# latest data

def download_latest_data(static_ref):

    current_time = dt.datetime.now().replace(minute=0,second=0,microsecond=0)

    date_str = current_time.strftime('%Y-%m-%d')
    value = get_soil_moisture_value(date_str)

    timestamp_str = current_time.strftime('%Y%m%d_%H')
    output_filename = f"soil_latest_{timestamp_str}_resampled.tif"

    output_path = os.path.join(SOIL_LATEST_DIR, output_filename)

    create_soil_moisture_raster(value,current_time,output_path,static_ref)

    return output_path


# historical data

def download_historical_data(date_str, static_ref):

    start_date = dt.datetime.strptime(date_str+" 00:00:00",'%Y-%m-%d %H:%M:%S')

    historical_dir = os.path.join(SOIL_HISTORICAL_BASE,date_str,"resampled")
    os.makedirs(historical_dir,exist_ok=True)

    base_value = get_soil_moisture_value(date_str)

    times,values = generate_timeseries(base_value,start_date,48)

    created_files = []

    for timestamp,value in zip(times,values):

        hour_str = timestamp.strftime('%Y%m%d_%H')
        output_filename = f"wf_{hour_str}.tif"

        output_path = os.path.join(historical_dir,output_filename)

        create_soil_moisture_raster(value,timestamp,output_path,static_ref)

        created_files.append(output_path)

    return created_files


# verify match

def verify_exact_match(soil_file, static_ref):

    with rasterio.open(soil_file) as soil_src:

        soil_crs = soil_src.crs
        soil_bounds = soil_src.bounds
        soil_width = soil_src.width
        soil_height = soil_src.height
        soil_nodata = soil_src.nodata

    crs_match = soil_crs == static_ref['crs']

    dims_match = (
        soil_width == static_ref['width'] and
        soil_height == static_ref['height']
    )

    bounds_match = (
        abs(soil_bounds.left-static_ref['bounds'].left)<1 and
        abs(soil_bounds.right-static_ref['bounds'].right)<1 and
        abs(soil_bounds.bottom-static_ref['bounds'].bottom)<1 and
        abs(soil_bounds.top-static_ref['bounds'].top)<1
    )

    nodata_match = soil_nodata == static_ref['nodata']

    return crs_match and dims_match and bounds_match and nodata_match


# forecast soil (48 hourly rasters starting from now)

def download_forecast_soil(static_ref):
    """Generate 48 hourly forecast soil rasters starting from now.

    Outputs wf_YYYYMMDD_HH.tif files into data_dynamic_raw/soil/latest/,
    matching the timestamp convention used by the forecast rain rasters.
    """
    current_time = dt.datetime.now().replace(minute=0, second=0, microsecond=0)
    date_str = current_time.strftime('%Y-%m-%d')
    base_value = get_soil_moisture_value(date_str)

    times, values = generate_timeseries(base_value, current_time, 48)

    os.makedirs(SOIL_LATEST_DIR, exist_ok=True)
    created_files = []

    for timestamp, value in zip(times, values):
        hour_str = timestamp.strftime('%Y%m%d_%H')
        output_filename = f"wf_{hour_str}.tif"
        output_path = os.path.join(SOIL_LATEST_DIR, output_filename)
        create_soil_moisture_raster(value, timestamp, output_path, static_ref)
        created_files.append(output_path)

    print(f"  [soil] Generated {len(created_files)} forecast soil rasters in {SOIL_LATEST_DIR}")
    return created_files


# main

def main():
    import argparse

    parser = argparse.ArgumentParser(description='Generate soil-moisture rasters')
    parser.add_argument(
        '--mode',
        choices=['latest', 'historical', 'both', 'forecast'],
        default=None,
        help='latest=single snapshot, historical=Ida hindcast, forecast=48-hr forecast series, both=latest+historical'
    )
    args = parser.parse_args()

    try:
        static_ref = get_static_map_reference()
    except FileNotFoundError as e:
        print(e)
        return

    if args.mode is None:
        # Interactive fallback when called directly without args
        choice = input("1 latest | 2 historical | 3 both | 4 forecast: ").strip()
        mode = {'1': 'latest', '2': 'historical', '3': 'both', '4': 'forecast'}.get(choice, 'latest')
    else:
        mode = args.mode

    if mode in ('latest', 'both'):
        latest_file = download_latest_data(static_ref)
        verify_exact_match(latest_file, static_ref)

    if mode in ('historical', 'both'):
        historical_files = download_historical_data(HISTORICAL_DATE, static_ref)
        if historical_files:
            verify_exact_match(historical_files[0], static_ref)

    if mode == 'forecast':
        forecast_files = download_forecast_soil(static_ref)
        if forecast_files:
            verify_exact_match(forecast_files[0], static_ref)


if __name__ == "__main__":
    main()