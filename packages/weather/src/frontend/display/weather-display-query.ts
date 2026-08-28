import { query } from "@k2b/stdlib/solid";
import { apiClient } from "../../api/client";
import { type WeatherDataPayload, WeatherDataSchema } from "../../contracts";
import { weatherMessages } from "../../messages";

const DISPLAY_REQUEST_TIMEOUT_MS = 10_000;

const readResponseError = async (response: Response, fallback: string): Promise<string> => {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

const fetchWeather = async (
  lat: string,
  lon: string,
  parentSignal: AbortSignal,
  messages: { refreshGenericFailed: string; refreshTimedOut: string },
): Promise<WeatherDataPayload> => {
  const request = new AbortController();
  let timedOut = false;
  const abort = () => request.abort();
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, DISPLAY_REQUEST_TIMEOUT_MS);

  try {
    const response = await apiClient.index.$get({ query: { lat, lon } }, { init: { cache: "no-store", signal: request.signal } });
    if (!response.ok) throw new Error(await readResponseError(response, messages.refreshGenericFailed));
    return WeatherDataSchema.parse(await response.json());
  } catch (error) {
    if (timedOut) throw new Error(messages.refreshTimedOut);
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
};

export const createWeatherDisplayQuery = (
  input: { lat: string; lon: string; initialData: WeatherDataPayload | null },
  locale: () => string = () => "en",
) => {
  const source = { lat: input.lat, lon: input.lon };
  return query.create({
    source: () => source,
    initial: { source, data: input.initialData },
    load: ({ lat, lon }, { abortSignal }) => {
      const t = weatherMessages.resolve([locale()]).t;
      return fetchWeather(lat, lon, abortSignal, t);
    },
  });
};
