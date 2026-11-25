import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import WeatherSettingsForm from "./_components/WeatherSettingsForm.island";
import WeatherScreen from "./WeatherScreen";
import { weatherScreenFixtures } from "./weather-screen.fixture";

// `?settings` shows the administrator's settings form (v1, outside this screen); otherwise the v2 overview without
// saved locations (or the fixture `?screen=` names), whose "Ort hinzufügen" opens the city search.
const params = new URL(location.href).searchParams;
const settings = params.has("settings");
const screen = weatherScreenFixtures[params.get("screen") ?? "empty"] ?? weatherScreenFixtures.empty!;
render(
  () => (
    <LocaleProvider locale="de">
      {settings ? (
        <WeatherSettingsForm
          initial={{ "weather.default_lat": "48.4", "weather.default_lon": "10", "weather.cache_minutes": 10 }}
          unreadable={{}}
        />
      ) : (
        <WeatherScreen {...screen} />
      )}
    </LocaleProvider>
  ),
  document.getElementById("app")!,
);
