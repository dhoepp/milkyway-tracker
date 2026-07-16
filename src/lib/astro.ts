import * as A from 'astronomy-engine';

export interface Loc {
  lat: number;
  lon: number;
}

// Galactic core (Sagittarius A*), J2000 equatorial coords.
// Precession over decades is < ~0.5deg — fine for a crude visibility tool.
const CORE_RA_HOURS = 17 + 45 / 60 + 40.04 / 3600; // 17.7611 h
const CORE_DEC_DEG = -(29 + 0 / 60 + 28.1 / 3600); // -29.0078 deg

// Below this altitude the core is heavily dimmed by atmospheric extinction/haze.
export const USEFUL_ALT = 10;

// Ideal altitude band: above ~30deg atmospheric extinction is low and the core
// looks crisp; 40deg+ is excellent. Used for the "site quality" disclaimer.
export const IDEAL_ALT_MIN = 30;
export const IDEAL_ALT_GOOD = 40;

const observerOf = (loc: Loc) => new A.Observer(loc.lat, loc.lon, 0);

export function coreHorizon(loc: Loc, date: Date): { altitude: number; azimuth: number } {
  const hor = A.Horizon(date, observerOf(loc), CORE_RA_HOURS, CORE_DEC_DEG, 'normal');
  return { altitude: hor.altitude, azimuth: hor.azimuth };
}

export function sunAltitude(loc: Loc, date: Date): number {
  const observer = observerOf(loc);
  const eq = A.Equator(A.Body.Sun, date, observer, true, true);
  return A.Horizon(date, observer, eq.ra, eq.dec, 'normal').altitude;
}

export function moonAltitude(loc: Loc, date: Date): number {
  const observer = observerOf(loc);
  const eq = A.Equator(A.Body.Moon, date, observer, true, true);
  return A.Horizon(date, observer, eq.ra, eq.dec, 'normal').altitude;
}

export interface MoonInfo {
  illumination: number; // 0..1 illuminated fraction
  phaseAngle: number; // 0..360 (0 new, 180 full)
  phaseName: string;
  rise: Date | null;
  set: Date | null;
}

function moonPhaseName(angle: number): string {
  if (angle < 22.5 || angle >= 337.5) return 'New Moon';
  if (angle < 67.5) return 'Waxing Crescent';
  if (angle < 112.5) return 'First Quarter';
  if (angle < 157.5) return 'Waxing Gibbous';
  if (angle < 202.5) return 'Full Moon';
  if (angle < 247.5) return 'Waning Gibbous';
  if (angle < 292.5) return 'Last Quarter';
  return 'Waning Crescent';
}

export function moonInfo(loc: Loc, refDate: Date): MoonInfo {
  const observer = observerOf(loc);
  const illum = A.Illumination(A.Body.Moon, refDate);
  const phaseAngle = A.MoonPhase(refDate);
  // Search a full day starting ~noon before the night for the relevant rise/set.
  const start = new Date(refDate.getTime() - 6 * 3600e3);
  const rise = A.SearchRiseSet(A.Body.Moon, observer, +1, start, 1.5);
  const set = A.SearchRiseSet(A.Body.Moon, observer, -1, start, 1.5);
  return {
    illumination: illum.phase_fraction,
    phaseAngle,
    phaseName: moonPhaseName(phaseAngle),
    rise: rise ? rise.date : null,
    set: set ? set.date : null,
  };
}

export interface DarknessWindow {
  dusk: Date | null; // sun descends below -18deg
  dawn: Date | null; // sun ascends above -18deg
  hasNight: boolean;
}

// Local noon (UTC-approximated via longitude) is a stable search anchor for "the night of" a day.
function noonAnchor(loc: Loc, day: Date): Date {
  const d = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0));
  // shift by longitude so 12:00 is near local solar noon
  return new Date(d.getTime() - (loc.lon / 15) * 3600e3);
}

export function astronomicalNight(loc: Loc, day: Date): DarknessWindow {
  const observer = observerOf(loc);
  const anchor = noonAnchor(loc, day);
  const dusk = A.SearchAltitude(A.Body.Sun, observer, -1, anchor, 1, -18);
  const dawn = dusk ? A.SearchAltitude(A.Body.Sun, observer, +1, dusk.date, 1, -18) : null;
  return {
    dusk: dusk ? dusk.date : null,
    dawn: dawn ? dawn.date : null,
    hasNight: !!(dusk && dawn),
  };
}

// --- Quality model -------------------------------------------------------

// Absolute core-altitude quality 0..1 (encodes horizon extinction/haze).
// Kept for reference; the app grades on a per-location curve instead (see below).
export function altitudeQuality(alt: number): number {
  if (alt <= 5) return 0;
  if (alt < 10) return lerp(alt, 5, 10, 0, 0.3);
  if (alt < 20) return lerp(alt, 10, 20, 0.3, 0.6);
  if (alt < 40) return lerp(alt, 20, 40, 0.6, 0.9);
  return Math.min(1, lerp(alt, 40, 70, 0.9, 1));
}

// Altitude below which the core is effectively lost to haze/extinction anywhere.
const HORIZON_FLOOR = 5;

// Graded-on-a-curve altitude quality: normalized to the location's own annual
// best core altitude, so a region's best possible night scores ~1.0 while still
// penalizing lower nights within that region. annualMax is degrees.
export function altitudeQualityRelative(alt: number, annualMax: number): number {
  if (annualMax <= HORIZON_FLOOR) return 0;
  return clamp((alt - HORIZON_FLOOR) / (annualMax - HORIZON_FLOOR), 0, 1);
}

// The best altitude the galactic core reaches during astronomical night across
// the whole year at this location — the "10/10" anchor for the local curve.
export function annualMaxCoreAltitude(loc: Loc, year: number): number {
  return monthlyOutlook(loc, year).reduce((max, m) => Math.max(max, m.peakAltitude), 0);
}

// Pure geometric ceiling: highest the core ever gets at culmination, ignoring
// darkness (90 - |lat - dec|). Used for the absolute "site potential" readout.
export function coreCeiling(loc: Loc): number {
  return Math.max(0, 90 - Math.abs(loc.lat - CORE_DEC_DEG));
}

// Moon washout: below horizon = no penalty; higher + more illuminated = worse.
export function moonPenalty(moonAlt: number, illum: number): number {
  if (moonAlt <= 0) return 1;
  const height = clamp(moonAlt / 40, 0, 1);
  return clamp(1 - illum * height * 0.9, 0.1, 1);
}

// Cloud cover % -> quality 0..1.
export function weatherQuality(cloudPct: number): number {
  if (cloudPct <= 20) return 1;
  if (cloudPct <= 60) return lerp(cloudPct, 20, 60, 1, 0.4);
  return clamp(lerp(cloudPct, 60, 100, 0.4, 0.05), 0.05, 1);
}

export type CloudLookup = (date: Date) => number | undefined;

export type LimitingFactor = 'clear' | 'cloud' | 'moon' | 'low altitude' | 'no darkness' | 'below horizon';

export interface NightScore {
  score: number; // 0..100
  limiting: LimitingFactor;
  windowStart: Date | null; // usable core window (dark + core above threshold + moon ok)
  windowEnd: Date | null;
  peakTime: Date | null;
  peakAltitude: number;
  peakAzimuth: number;
  cloudAtPeak: number | undefined;
}

// Score a single night. cloud lookup is optional (astronomy still works offline).
// annualMaxAlt grades altitude on the location's own curve; if omitted or <=0,
// falls back to the absolute altitude quality.
export function scoreNight(loc: Loc, day: Date, cloud?: CloudLookup, annualMaxAlt?: number): NightScore {
  const night = astronomicalNight(loc, day);
  const empty: NightScore = {
    score: 0,
    limiting: 'no darkness',
    windowStart: null,
    windowEnd: null,
    peakTime: null,
    peakAltitude: 0,
    peakAzimuth: 0,
    cloudAtPeak: undefined,
  };
  if (!night.hasNight || !night.dusk || !night.dawn) return empty;

  const stepMs = 15 * 60e3;
  let best = -1;
  let peak: NightScore = { ...empty, limiting: 'below horizon' };
  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;

  for (let t = night.dusk.getTime(); t <= night.dawn.getTime(); t += stepMs) {
    const date = new Date(t);
    const core = coreHorizon(loc, date);
    if (core.altitude < USEFUL_ALT) continue;
    const mAlt = moonAltitude(loc, date);
    const mInfo = A.Illumination(A.Body.Moon, date).phase_fraction;
    const altQ = annualMaxAlt && annualMaxAlt > 0
      ? altitudeQualityRelative(core.altitude, annualMaxAlt)
      : altitudeQuality(core.altitude);
    const moonQ = moonPenalty(mAlt, mInfo);
    const cloudPct = cloud ? cloud(date) : undefined;
    const wQ = cloudPct === undefined ? 1 : weatherQuality(cloudPct);
    const s = altQ * moonQ * wQ;

    // usable window: core up, dark, moon not dominating
    if (moonQ > 0.5) {
      if (!windowStart) windowStart = date;
      windowEnd = date;
    }

    if (s > best) {
      best = s;
      let limiting: LimitingFactor = 'clear';
      const factors: [LimitingFactor, number][] = [
        ['cloud', wQ],
        ['moon', moonQ],
        ['low altitude', altQ],
      ];
      factors.sort((a, b) => a[1] - b[1]);
      if (factors[0][1] < 0.6) limiting = factors[0][0];
      peak = {
        score: 0,
        limiting,
        windowStart: null,
        windowEnd: null,
        peakTime: date,
        peakAltitude: core.altitude,
        peakAzimuth: core.azimuth,
        cloudAtPeak: cloudPct,
      };
    }
  }

  if (best < 0) return { ...empty, limiting: 'below horizon' };
  return {
    ...peak,
    score: Math.round(best * 100),
    windowStart,
    windowEnd,
  };
}

// --- Galactic plane arc (for the sky visual) -----------------------------

export interface SkyPoint {
  az: number; // 0..360 compass azimuth
  alt: number; // degrees above horizon (may be < 0)
  w: number; // 0..1 relative brightness (brightest near the core)
}

export interface GalacticArc {
  points: SkyPoint[];
  core: { az: number; alt: number };
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function unitVec(raDeg: number, decDeg: number): [number, number, number] {
  const r = raDeg * D2R, d = decDeg * D2R;
  return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)];
}
function cross(a: number[], b: number[]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: number[]): [number, number, number] {
  const m = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / m, a[1] / m, a[2] / m];
}

// J2000 equatorial coords of the galactic center and north galactic pole.
const NGP = unitVec(192.8595, 27.1284);
const GC = unitVec(266.4051, -28.9362); // galactic longitude 0 (the bright core)

// Sample the galactic equator (the Milky Way band) as a great circle and project
// it into horizontal (az/alt) coords for the given time & location.
export function galacticArc(loc: Loc, date: Date): GalacticArc {
  const observer = observerOf(loc);
  const c = GC;
  const d = normalize(cross(NGP, c)); // second in-plane axis
  const points: SkyPoint[] = [];
  for (let deg = 0; deg < 360; deg += 2) {
    const th = deg * D2R;
    const p: [number, number, number] = [
      c[0] * Math.cos(th) + d[0] * Math.sin(th),
      c[1] * Math.cos(th) + d[1] * Math.sin(th),
      c[2] * Math.cos(th) + d[2] * Math.sin(th),
    ];
    const raDeg = (Math.atan2(p[1], p[0]) * R2D + 360) % 360;
    const decDeg = Math.asin(p[2]) * R2D;
    const hor = A.Horizon(date, observer, raDeg / 15, decDeg, 'normal');
    // brightness peaks toward the galactic center (deg near 0 / 360)
    const dcore = Math.min(deg, 360 - deg); // 0..180
    const w = 0.2 + 0.8 * Math.exp(-(dcore * dcore) / (2 * 45 * 45));
    points.push({ az: hor.azimuth, alt: hor.altitude, w });
  }
  const coreHor = A.Horizon(date, observer, 266.4051 / 15, -28.9362, 'normal');
  return { points, core: { az: coreHor.azimuth, alt: coreHor.altitude } };
}

// --- Photography guidance ------------------------------------------------

export function compassLabel(azimuth: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(azimuth / 22.5) % 16];
}

// --- Monthly / yearly outlook -------------------------------------------

export interface MonthOutlook {
  month: number; // 0..11
  peakAltitude: number;
  peakAzimuth: number;
  bestTime: Date | null;
  // Where in the night the core peaks: early (just after dusk), middle, or
  // late (near dawn). null when the core isn't visible that month.
  bestTimePhase: 'dusk' | 'mid' | 'dawn' | null;
  hasNight: boolean;
}

// Peak core altitude reached during astronomical night on the 15th of each month.
export function monthlyOutlook(loc: Loc, year: number): MonthOutlook[] {
  const out: MonthOutlook[] = [];
  for (let m = 0; m < 12; m++) {
    const day = new Date(year, m, 15);
    const night = astronomicalNight(loc, day);
    let peakAlt = -90;
    let peakAz = 0;
    let bestTime: Date | null = null;
    let phase: 'dusk' | 'mid' | 'dawn' | null = null;
    if (night.hasNight && night.dusk && night.dawn) {
      const t0 = night.dusk.getTime();
      const t1 = night.dawn.getTime();
      for (let t = t0; t <= t1; t += 15 * 60e3) {
        const date = new Date(t);
        const core = coreHorizon(loc, date);
        if (core.altitude > peakAlt) {
          peakAlt = core.altitude;
          peakAz = core.azimuth;
          bestTime = date;
        }
      }
      if (bestTime && peakAlt >= USEFUL_ALT) {
        const frac = (bestTime.getTime() - t0) / (t1 - t0);
        phase = frac < 0.34 ? 'dusk' : frac > 0.66 ? 'dawn' : 'mid';
      }
    }
    out.push({
      month: m,
      peakAltitude: Math.max(0, peakAlt),
      peakAzimuth: peakAz,
      bestTime,
      bestTimePhase: phase,
      hasNight: night.hasNight,
    });
  }
  return out;
}

// --- small helpers -------------------------------------------------------

function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
