/**
 * The forecasts a place page asks for: one per saved place (the sidebar shows each one's weather; the provider cache
 * answers repeated ones), or none when the address names no saved place, so a 404 costs no forecast at all.
 * (Saved places have no upper bound yet: #4368.)
 */
export const placeForecasts = async <Place, Forecast>(
  places: readonly Place[],
  hasOpenPlace: boolean,
  forecast: (place: Place) => Promise<Forecast>,
): Promise<(Forecast | null)[]> => (hasOpenPlace ? Promise.all(places.map(forecast)) : places.map(() => null));
