import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Choice,
  Dialog,
  Empty,
  Facts,
  Failed,
  Field,
  Lookup,
  Menu,
  type MenuEntry,
  Nav,
  type NavGroup,
  Notice,
  Pane,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { weatherMessages } from "../messages";
import RadarCard from "./_components/RadarCard";
import { buildDisplayUrl } from "./params";
import type { GeoResult, WeatherNow, WeatherOpen, WeatherPlace } from "./weather-view";

export type WeatherScreenProps = {
  places: readonly WeatherPlace[];
  /** The open location; none on the overview, and none when the address names a location that is not saved. */
  open: WeatherOpen | null;
  /** The address named a location that is not among the saved ones. */
  missing?: boolean;
  /** The forecast of the open location; null when the provider had none. */
  weather: WeatherNow | null;
};

const messageOf = async (response: { json: () => Promise<unknown> }, fallback: string) => {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};
const geoKey = (place: GeoResult) => JSON.stringify([place.name, place.lat, place.lon]);

/**
 * Weather on v2: the saved locations in the sidebar, the open one as a record. Its current weather leads in the status
 * row and the cells, the hours and days are tables, the radar and the remaining values stand at the side. Adding a
 * location and setting up the wall display are dialogs; removing asks first.
 */
export default function WeatherScreen(props: WeatherScreenProps) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const toast = useToast();
  const cloudId = useCloudIdCopy();
  const [adding, setAdding] = createSignal(false);
  const [displaying, setDisplaying] = createSignal(false);

  const groups = (): NavGroup[] => [
    {
      label: t().locations,
      action: { label: t().addLocation, icon: "plus", onClick: () => setAdding(true) },
      items: props.places.map((place) => ({
        label: place.name,
        icon: place.icon,
        href: `/app/weather/${place.id}`,
        current: place.id === props.open?.id,
        count: place.temperature ?? undefined,
      })),
    },
  ];
  const add = { label: t().addLocation, icon: "map-pin-plus", onClick: () => setAdding(true) };

  const remove = async (id: string) => {
    if (!(await Dialog.confirm({ title: t().removeLocationConfirm, confirm: t().removeLocation }))) return;
    const response = await apiClient.locations[":id"].$delete({ param: { id } }).catch(() => null);
    if (!response?.ok) {
      toast(response ? await messageOf(response, t().removeLocationFailed) : t().removeLocationFailed, { status: "bad" });
      return;
    }
    toast(t().locationRemoved, { status: "ok" });
    navigateTo("/app/weather");
  };
  const menu = (open: WeatherOpen): MenuEntry[] => [
    ...(cloudId.available()
      ? [
          {
            label: cloudIdMessages.resolve([locale()]).t.copy,
            icon: "id",
            onClick: () => cloudId.copy({ type: "weather.location", id: open.id }),
          },
        ]
      : []),
    { label: t().removeLocation, icon: "trash", danger: true, onClick: () => void remove(open.id) },
  ];

  return (
    <>
      <V2WorkspaceNavigation label={props.open?.name ?? t().appName} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().appName} icon="temperature-celsius" groups={groups()} />}
        head={
          <Bar
            start={<Text type="body">{props.open?.name ?? t().appName}</Text>}
            end={
              <>
                <Show when={props.open}>
                  {(open) => (
                    <>
                      <Button icon="device-tv" onClick={() => setDisplaying(true)}>
                        {t().display}
                      </Button>
                      <Menu label={t().locationOptions} items={menu(open())} />
                    </>
                  )}
                </Show>
                <Button variant="primary" icon="map-pin-plus" onClick={() => setAdding(true)}>
                  {t().addLocation}
                </Button>
              </>
            }
          />
        }
        primary={add}
      >
        <Show
          when={props.open}
          fallback={
            <Pane label={t().appName}>
              <Empty
                icon={props.missing ? "map-pin-off" : "map-pin"}
                text={
                  props.missing
                    ? `${t().locationNotFound}. ${t().locationNotFoundDescription}`
                    : `${t().noLocationsTitle}. ${t().noLocationsDescription}`
                }
                action={add}
              />
            </Pane>
          }
        >
          {(open) => (
            <Show
              when={props.weather}
              fallback={
                <Pane label={open().name}>
                  <Failed text={t().weatherUnavailableGermany} onRetry={() => window.location.reload()} />
                </Pane>
              }
            >
              {(weather) => <WeatherRecord open={open()} weather={weather()} />}
            </Show>
          )}
        </Show>
      </Workspace>
      <AddLocationDialog open={adding()} onOpenChange={setAdding} />
      <Show when={props.open}>
        {(open) => <DisplayDialog open={displaying()} onOpenChange={setDisplaying} lat={open().lat} lon={open().lon} />}
      </Show>
    </>
  );
}

/** The open location: what it is like now, the next hours and days, the radar. */
function WeatherRecord(props: { open: WeatherOpen; weather: WeatherNow }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const w = () => props.weather;
  return (
    <Pane
      label={t().weatherFor({ name: props.open.name })}
      scrollKey={`weather-${props.open.id}`}
      status={
        <StatusRow
          lead={`${w().temperature} · ${w().condition}`}
          facts={[{ before: `${t().station} `, value: w().station }, ...(props.open.state ? [{ value: props.open.state }] : [])]}
        />
      }
    >
      <Cells>
        <Cells.Cell icon="droplet" label={t().humidity} value={w().humidity} />
        <Cells.Cell icon="wind" label={t().wind} value={w().wind} />
        <Cells.Cell icon="umbrella" label={t().rain} value={w().rain} />
        <Cells.Cell icon="cloud" label={t().clouds} value={w().clouds} />
      </Cells>
      <Pane.Split>
        <Pane label={t().hourlyForecast}>
          <Section icon="clock" title={t().hourly}>
            <Show when={w().hourly.length > 0} fallback={<Empty icon="clock" text={t().noForecast} />}>
              <Table
                label={t().hourlyForecast}
                rows={w().hourly}
                phone={(hour) => ({ lines: [`${hour.time} · ${hour.temperature}`, hour.condition], time: hour.rain })}
                columns={[
                  { title: t().time, width: { min: 72, default: 96 }, cell: (hour) => hour.time },
                  { title: t().condition, width: { min: 140, default: 220 }, cell: (hour) => hour.condition },
                  { title: t().temperature, width: { min: 96, default: 112 }, align: "end", cell: (hour) => hour.temperature },
                  { title: t().rainChance, align: "end", cell: (hour) => hour.rain },
                ]}
              />
            </Show>
          </Section>
          <Section icon="calendar" title={t().sevenDayForecast}>
            <Show when={w().daily.length > 0} fallback={<Empty icon="calendar" text={t().noForecast} />}>
              <Table
                label={t().sevenDayForecast}
                rows={w().daily}
                phone={(day) => ({ lines: [`${day.day} · ${day.range}`, day.condition], time: day.rain })}
                columns={[
                  { title: t().day, width: { min: 72, default: 96 }, cell: (day) => day.day },
                  { title: t().condition, width: { min: 140, default: 200 }, cell: (day) => day.condition },
                  { title: t().temperature, width: { min: 96, default: 120 }, align: "end", cell: (day) => day.range },
                  { title: t().rainChance, width: { min: 72, default: 80 }, align: "end", cell: (day) => day.rain },
                  { title: t().sunshineDay, align: "end", drop: true, cell: (day) => day.sunshine },
                ]}
              />
            </Show>
          </Section>
        </Pane>
        <Pane side width={{ min: 300, default: 360 }} label={t().currentConditions}>
          <Section icon="gauge" title={t().currentConditions}>
            <Facts
              items={[
                { label: t().pressure, value: w().pressure },
                { label: t().dewPoint, value: w().dewPoint },
                { label: t().visibility, value: w().visibility },
                { label: t().sunshine, value: w().sunshine },
              ]}
            />
          </Section>
          <Section icon="radar" title={t().rainRadar}>
            <Canvas label={t().radarAlt}>
              {/* the radar keeps the text edge, so its dark picture never meets the column's line */}
              <div style={{ padding: "0 20px" }}>
                <RadarCard showLegend />
              </div>
            </Canvas>
          </Section>
          <Show when={props.open.geoapify}>
            <Section icon="map-pin" title={t().location}>
              <Text type="meta" href="https://www.geoapify.com/">
                {t().locationSource}
              </Text>
              <Text type="meta" href="https://www.openstreetmap.org/copyright">
                {t().openStreetMap}
              </Text>
            </Section>
          </Show>
        </Pane>
      </Pane.Split>
    </Pane>
  );
}

/** Find a German city and save it; the search loads while the person types (at least three characters). */
function AddLocationDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const toast = useToast();
  const found = new Map<string, GeoResult>();
  const [chosen, setChosen] = createSignal<string>();
  const [saving, setSaving] = createSignal(false);
  const [searchError, setSearchError] = createSignal<string>();
  const close = (open: boolean) => {
    if (!open) {
      setChosen(undefined);
      setSearchError(undefined);
    }
    props.onOpenChange(open);
  };
  const save = async () => {
    const place = found.get(chosen() ?? "");
    if (!place || saving()) return;
    setSaving(true);
    try {
      const response = await apiClient.locations.$post({
        json: { name: place.name, state: place.state, lat: place.lat, lon: place.lon, provenance: place.provenance },
      });
      if (!response.ok) {
        toast(await messageOf(response, t().addLocationFailed), { status: "bad" });
        return;
      }
      const { id } = (await response.json()) as { id: string };
      toast(t().locationAdded, { status: "ok" });
      close(false);
      navigateTo(`/app/weather/${id}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t().addLocation}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)}>{t().cancel}</Button>
          <Button variant="primary" busy={saving()} disabled={!chosen()} onClick={() => void save()}>
            {t().add}
          </Button>
        </>
      }
    >
      {/* k2b-ui gap: Lookup shows only its own "could not load" for a failed search, not the reason the server gave
          (such as when the search budget is back); the reason stands in a notice above it until Lookup can say it. */}
      <Show when={searchError()}>
        {(message) => (
          <Notice tone="warn" title={t().citySearchFailed}>
            {message()}
          </Notice>
        )}
      </Show>
      <Lookup
        label={t().locationSearch}
        value={chosen() ? [chosen()!] : []}
        minChars={3}
        onChange={(values) => setChosen(values.at(-1))}
        load={async (query, { signal, limit }) => {
          const response = await apiClient.geo.search.$get({ query: { q: query.trim(), country: "DE" } }, { init: { signal } });
          if (!response.ok) {
            const message = await messageOf(response, t().citySearchFailed);
            setSearchError(message);
            throw new Error(message);
          }
          setSearchError(undefined);
          const places = ((await response.json()) as GeoResult[]).slice(0, limit);
          for (const place of places) found.set(geoKey(place), place);
          return {
            items: places.map((place) => ({
              value: geoKey(place),
              label: place.name,
              meta: [place.state, place.country].filter(Boolean).join(", ") || undefined,
            })),
          };
        }}
      />
      <Text type="meta" href="https://www.geoapify.com/">
        Geoapify
      </Text>
      <Text type="meta" href="https://www.openstreetmap.org/copyright">
        OpenStreetMap
      </Text>
    </Dialog>
  );
}

/** How the wall display looks; it opens in a new window, where it stays full screen and refreshes on its own. */
function DisplayDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; lat: number; lon: number }) {
  const locale = useLocale();
  const t = () => weatherMessages.resolve([locale()]).t;
  const [zoom, setZoom] = createSignal("2");
  const [theme, setTheme] = createSignal("dark");
  const [view, setView] = createSignal("simple");
  const openDisplay = () => {
    const settings = {
      zoom: Number.parseInt(zoom(), 10) as 1 | 2 | 3,
      theme: theme() === "light" ? ("light" as const) : ("dark" as const),
      detail: view() === "detail",
    };
    window.open(buildDisplayUrl(props.lat, props.lon, settings), "_blank");
    props.onOpenChange(false);
  };
  return (
    <Dialog
      title={t().displaySettings}
      open={props.open}
      onOpenChange={props.onOpenChange}
      foot={
        <>
          <Button onClick={() => props.onOpenChange(false)}>{t().cancel}</Button>
          <Button variant="primary" icon="external-link" onClick={openDisplay}>
            {t().openDisplay}
          </Button>
        </>
      }
    >
      <Field label={t().zoomLevel}>
        <Choice
          name="weather-display-zoom"
          value={zoom()}
          onChange={setZoom}
          options={[
            { value: "1", label: t().small },
            { value: "2", label: t().medium },
            { value: "3", label: t().large },
          ]}
        />
      </Field>
      <Field label={t().theme}>
        <Choice
          name="weather-display-theme"
          value={theme()}
          onChange={setTheme}
          options={[
            { value: "light", label: t().lightTheme },
            { value: "dark", label: t().darkTheme },
          ]}
        />
      </Field>
      <Field label={t().view}>
        <Choice
          name="weather-display-view"
          value={view()}
          onChange={setView}
          options={[
            { value: "simple", label: t().simple },
            { value: "detail", label: t().detailed },
          ]}
        />
      </Field>
    </Dialog>
  );
}
