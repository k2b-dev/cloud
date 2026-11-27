/**
 * Day and night from the sun's place: the forecast names night only for clear and partly cloudy hours, so a rainy or
 * overcast night would draw no night at all. The sun's elevation for a place and a moment comes from NOAA's general
 * solar position formulas (accurate to about a minute for sunrise and sunset), in UTC, so summer time changes nothing.
 */

const RADIANS = Math.PI / 180;
/** The sun's centre below the horizon at sunrise and sunset: its radius and the bending of the air. */
const HORIZON = -0.833;

/** The sun's elevation above the horizon in degrees, at a latitude and longitude and a moment. */
export const sunElevation = (lat: number, lon: number, at: Date): number => {
  const year = at.getUTCFullYear();
  const days = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
  const dayOfYear = (Date.UTC(year, at.getUTCMonth(), at.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const hours = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;
  // the fractional year in radians
  const year2pi = ((2 * Math.PI) / days) * (dayOfYear - 1 + (hours - 12) / 24);
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(year2pi) -
      0.032077 * Math.sin(year2pi) -
      0.014615 * Math.cos(2 * year2pi) -
      0.040849 * Math.sin(2 * year2pi));
  const declination =
    0.006918 -
    0.399912 * Math.cos(year2pi) +
    0.070257 * Math.sin(year2pi) -
    0.006758 * Math.cos(2 * year2pi) +
    0.000907 * Math.sin(2 * year2pi) -
    0.002697 * Math.cos(3 * year2pi) +
    0.00148 * Math.sin(3 * year2pi);
  // true solar time in minutes, and the hour angle in degrees
  const solarTime = hours * 60 + equationOfTime + 4 * lon;
  const hourAngle = solarTime / 4 - 180;
  const cosZenith =
    Math.sin(lat * RADIANS) * Math.sin(declination) + Math.cos(lat * RADIANS) * Math.cos(declination) * Math.cos(hourAngle * RADIANS);
  return 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / RADIANS;
};

/** Whether the sun is down at a place and a moment: below the horizon as sunrise and sunset count it. */
export const isNight = (lat: number, lon: number, at: Date) => sunElevation(lat, lon, at) < HORIZON;
