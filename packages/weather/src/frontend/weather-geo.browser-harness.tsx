import { Button, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import WeatherSettingsForm from "./_components/WeatherSettingsForm.island";
import { createLocationPicker } from "./location-picker";

function WeatherGeoFixture() {
  const picker = createLocationPicker();
  return (
    <main class="mx-auto max-w-3xl p-4">
      <Button onClick={() => void picker.selectLocation()}>Ort hinzufügen</Button>
      <WeatherSettingsForm
        initial={{ "weather.default_lat": "48.4", "weather.default_lon": "10", "weather.cache_minutes": 10 }}
        unreadable={{}}
      />
    </main>
  );
}
render(
  () => (
    <LocaleProvider locale="de">
      <WeatherGeoFixture />
    </LocaleProvider>
  ),
  document.getElementById("app")!,
);
