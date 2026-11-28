/**
 * How many forecasts a page asks for at once. A cold provider call may take its whole timeout (400 ms, `forecast.ts`);
 * the most places a person saves (100) then fit a 2 s page budget in five waves: 100 / 20 × 400 ms = 2 s.
 */
export const PLACE_FORECASTS_AT_ONCE = 20;

/**
 * The forecasts a place page asks for: one per saved place (the sidebar shows each one's weather; the provider cache
 * answers repeated ones), at most `PLACE_FORECASTS_AT_ONCE` at a time, in the order of the places; or none when the
 * address names no saved place, so a 404 costs no forecast at all.
 */
export const placeForecasts = async <Place, Forecast>(
  places: readonly Place[],
  hasOpenPlace: boolean,
  forecast: (place: Place) => Promise<Forecast>,
): Promise<(Forecast | null)[]> => {
  if (!hasOpenPlace) return places.map(() => null);
  const results: Forecast[] = new Array(places.length);
  let next = 0;
  const worker = async () => {
    while (next < places.length) {
      const index = next++;
      results[index] = await forecast(places[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PLACE_FORECASTS_AT_ONCE, places.length) }, worker));
  return results;
};
