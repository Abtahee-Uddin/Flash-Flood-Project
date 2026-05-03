import os
import requests
import pandas as pd
from datetime import datetime

latitude = 40.73
longitude = -74.08
forecast_days = 2
url = "https://api.open-meteo.com/v1/forecast"

params = {
    "latitude": latitude,
    "longitude": longitude,
    "hourly": "precipitation",
    "forecast_days": forecast_days,
    "timezone": "UTC"
}
response = requests.get(url, params=params)
data = response.json()

df = pd.DataFrame({
    "time": data["hourly"]["time"],
    "precip_mm": data["hourly"]["precipitation"]
})
df["time"] = pd.to_datetime(df["time"])

forecast_folder = "data_dynamic_raw/rainfall/forecast/"
os.makedirs(forecast_folder, exist_ok=True)
now = datetime.utcnow().strftime("%Y%m%d_%H")
csv_path = os.path.join(forecast_folder, f"forecast_{now}.csv")
df.to_csv(csv_path, index=False)
print(f"Forecast rainfall saved to {csv_path}")