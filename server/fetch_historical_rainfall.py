import os
import requests
import pandas as pd

latitude = 40.73
longitude = -74.08
start_date = "2021-09-01"
end_date = "2021-09-02"
url = "https://archive-api.open-meteo.com/v1/archive"

params = {
    "latitude": latitude,
    "longitude": longitude,
    "start_date": start_date,
    "end_date": end_date,
    "hourly": "precipitation",
    "timezone": "UTC"
}
response = requests.get(url, params=params)
data = response.json()

df = pd.DataFrame({
    "time": data["hourly"]["time"],
    "precip_mm": data["hourly"]["precipitation"]
})
df["time"] = pd.to_datetime(df["time"])

# Save in event folder
event_folder = f"data_dynamic_raw/rainfall/historical/{start_date}/"
os.makedirs(event_folder, exist_ok=True)
csv_path = os.path.join(event_folder, "rain_hourly.csv")
df.to_csv(csv_path, index=False)
print(f"Historical rainfall saved to {csv_path}")