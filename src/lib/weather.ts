// Open-Meteo hourly cloud cover forecast. Free, no API key, non-commercial use.

export interface CloudForecast {
  // epoch ms (hour start, local) -> total cloud cover %
  byHour: Map<number, number>;
  fetchedAt: number;
}

export type Sky = 'clear' | 'partly' | 'cloudy';

export function skyFromCloud(cloudPct: number): Sky {
  if (cloudPct <= 20) return 'clear';
  if (cloudPct <= 60) return 'partly';
  return 'cloudy';
}

export function skyLabel(sky: Sky): string {
  return sky === 'clear' ? 'Clear' : sky === 'partly' ? 'Partly cloudy' : 'Cloudy';
}

// Round a date down to its hour and return epoch ms — the key used in byHour.
function hourKey(d: Date): number {
  const c = new Date(d);
  c.setMinutes(0, 0, 0);
  return c.getTime();
}

export async function fetchClouds(lat: number, lon: number): Promise<CloudForecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&hourly=cloud_cover&forecast_days=8&timezone=auto`;
  // Time out so a hung request never blocks a re-render.
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json();
  const times: string[] = data?.hourly?.time ?? [];
  const cover: number[] = data?.hourly?.cloud_cover ?? [];
  const byHour = new Map<number, number>();
  for (let i = 0; i < times.length; i++) {
    // times are local (timezone=auto), format "YYYY-MM-DDTHH:mm" with no zone suffix.
    const t = new Date(times[i]);
    byHour.set(hourKey(t), cover[i]);
  }
  return { byHour, fetchedAt: Date.now() };
}

// Adapt a forecast into the CloudLookup that astro.scoreNight expects.
export function cloudLookup(forecast: CloudForecast | null) {
  return (date: Date): number | undefined => {
    if (!forecast) return undefined;
    return forecast.byHour.get(hourKey(date));
  };
}
