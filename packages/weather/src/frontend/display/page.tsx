import { getLocale } from "@k2b/cloud/server";
import { weatherService } from "@k2b/cloud/services";
import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { ssr } from "../../config";
import { weatherMessages } from "../../messages";
import DisplayMissing from "./DisplayMissing";
import PublicWeatherDisplay from "./PublicWeatherDisplay.island";
import { parseDisplayCoordinate, parseDisplayRefreshSeconds } from "./runtime";

/**
 * The v2 scope of a page without Cloud's layout: the wall display fills the window, light or dark as its address says.
 * (Within Cloud's layout, `Layout ui="v2"` sets this scope on the page's main area.)
 */
const Scope = (props: { children: JSX.Element }) => (
  <div class="k2-ui" style={{ display: "flex", height: "100dvh" }}>
    {props.children}
  </div>
);

export default ssr(async (c) => {
  const locale = getLocale(c);
  const { t } = weatherMessages.resolve([locale]);
  const lat = parseDisplayCoordinate(c.req.query("lat"), -90, 90);
  const lon = parseDisplayCoordinate(c.req.query("lon"), -180, 180);
  const zoomValue = Number.parseInt(c.req.query("zoom") ?? "2", 10);
  const zoom = Math.max(1, Math.min(3, Number.isFinite(zoomValue) ? zoomValue : 2)) as 1 | 2 | 3;
  const refreshSeconds = parseDisplayRefreshSeconds(c.req.query("refresh"));
  const detail = c.req.query("detail") === "true";

  c.get("page").theme = c.req.query("theme") === "dark" ? "dark" : "light";

  if (!lat || !lon) {
    return () => (
      <LocaleProvider locale={locale}>
        <Scope>
          <DisplayMissing title={t.displayLocationMissing} text={t.displayLocationMissingDescription} />
        </Scope>
      </LocaleProvider>
    );
  }

  const initialData = await weatherService.forecast.get({ lat, lon });

  return () => (
    <LocaleProvider locale={locale}>
      <Scope>
        <PublicWeatherDisplay
          lat={lat}
          lon={lon}
          location={initialData?.current.stationName ?? `${lat}, ${lon}`}
          state={null}
          initialData={initialData}
          initialNow={new Date().toISOString()}
          zoom={zoom}
          detail={detail}
          refreshSeconds={refreshSeconds}
        />
      </Scope>
    </LocaleProvider>
  );
});
