import { i18n } from "@k2b/stdlib";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { useLocale } from "../intl/locale";
import { WORLD_COUNTRY_DOTS, WORLD_COUNTRY_SHAPES, WORLD_MAP_VIEW_HEIGHT, WORLD_MAP_VIEW_WIDTH } from "./world-countries";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      total: "Total",
      more: ({ count }: { count: string }) => `+${count} more`,
      legend: ({ low, high }: { low: string; high: string }) => `Color scale from ${low} to ${high}`,
    },
    de: {
      total: "Gesamt",
      more: ({ count }: { count: string }) => `+${count} weitere`,
      legend: ({ low, high }: { low: string; high: string }) => `Farbskala von ${low} bis ${high}`,
    },
  },
});

export type CountryMapDatum = {
  /** ISO 3166-1 alpha-2 code. Other values appear neither on the map nor in the list. */
  code: string;
  value: number;
};

export type CountryMapProps = {
  data: readonly CountryMapDatum[];
  /** Accessible name of the map, such as the panel title. */
  label: string;
  format?: (value: number) => string;
  /** How many countries the ranked list names. */
  limit?: number;
  class?: string;
};

/** Square root keeps a long tail of small countries visible next to one dominant value. */
const fill = (value: number, max: number) =>
  `color-mix(in srgb, var(--stdlib-chart-c1) ${Math.round(20 + 80 * Math.sqrt(value / max))}%, var(--k2b-surface-muted))`;

/**
 * A world map that shades countries by one value, with a ranked list that names the same numbers.
 * The geometry ships with the component, so the map makes no network request.
 * @example <CountryMap label="Visitors" data={[{ code: "DE", value: 1200 }, { code: "FR", value: 300 }]} />
 */
export function CountryMap(props: CountryMapProps): JSX.Element {
  const locale = useLocale();
  const t = () => messages.resolve([locale()]).t;
  const [active, setActive] = createSignal<string>();
  const number = (value: number) => (props.format ?? new Intl.NumberFormat(locale()).format)(value);
  const names = createMemo(() => new Intl.DisplayNames([locale()], { type: "region", fallback: "code" }));
  const name = (code: string) => names().of(code) ?? code;
  const rows = createMemo(() => {
    const totals = new Map<string, number>();
    for (const { code, value } of props.data)
      if (/^[A-Za-z]{2}$/.test(code) && Number.isFinite(value) && value > 0)
        totals.set(code.toUpperCase(), (totals.get(code.toUpperCase()) ?? 0) + value);
    return [...totals].map(([code, value]) => ({ code, value })).sort((a, b) => b.value - a.value || a.code.localeCompare(b.code));
  });
  const values = createMemo(() => new Map(rows().map((row) => [row.code, row.value])));
  const max = () => rows()[0]?.value ?? 0;
  const min = () => rows().at(-1)?.value ?? 0;
  const total = () => rows().reduce((sum, row) => sum + row.value, 0);
  const limit = () => props.limit ?? 8;
  const countryFill = (code: string) => {
    const value = values().get(code);
    return value === undefined ? undefined : fill(value, max());
  };
  const readout = () => {
    const code = active();
    const value = code === undefined ? undefined : values().get(code);
    if (code === undefined) return `${t().total}: ${number(total())}`;
    return value === undefined ? name(code) : `${name(code)}: ${number(value)} (${Math.round((value / total()) * 100)} %)`;
  };
  const inspect: JSX.EventHandler<SVGSVGElement, PointerEvent> = (event) => {
    setActive((event.target as Element).closest("[data-country]")?.getAttribute("data-country") ?? undefined);
  };
  return (
    <figure class={`k2b-country-map ${props.class ?? ""}`.trim()}>
      <div class="k2b-country-map__plot">
        <svg
          class="k2b-country-map__svg"
          viewBox={`0 0 ${WORLD_MAP_VIEW_WIDTH} ${WORLD_MAP_VIEW_HEIGHT}`}
          role="img"
          aria-label={props.label}
          onPointerMove={inspect}
          onPointerDown={inspect}
          onPointerLeave={() => setActive(undefined)}
        >
          <For each={WORLD_COUNTRY_SHAPES}>
            {([code, d]) => <path data-country={code} data-active={active() === code} d={d} style={{ fill: countryFill(code) }} />}
          </For>
          <For each={WORLD_COUNTRY_DOTS}>
            {([code, x, y]) => (
              <Show when={values().has(code)}>
                <circle data-country={code} data-active={active() === code} cx={x} cy={y} r={4} style={{ fill: countryFill(code) }} />
              </Show>
            )}
          </For>
        </svg>
        <figcaption class="k2b-country-map__caption">
          <span class="k2b-country-map__readout">{readout()}</span>
          <Show when={rows().length > 1}>
            <span class="k2b-country-map__legend" role="img" aria-label={t().legend({ low: number(min()), high: number(max()) })}>
              <span aria-hidden="true">{number(min())}</span>
              <span
                class="k2b-country-map__scale"
                aria-hidden="true"
                style={{ background: `linear-gradient(to right, ${fill(0, 1)}, ${fill(1, 1)})` }}
              />
              <span aria-hidden="true">{number(max())}</span>
            </span>
          </Show>
        </figcaption>
      </div>
      <Show when={rows().length}>
        <ol class="k2b-country-map__list">
          <For each={rows().slice(0, limit())}>
            {(row) => (
              <li
                class="k2b-country-map__row"
                data-active={active() === row.code}
                onPointerEnter={() => setActive(row.code)}
                onPointerLeave={() => setActive(undefined)}
              >
                <span class="k2b-country-map__name">{name(row.code)}</span>
                <span class="k2b-country-map__value">{number(row.value)}</span>
              </li>
            )}
          </For>
          <Show when={rows().length > limit()}>
            <li class="k2b-country-map__more">{t().more({ count: number(rows().length - limit()) })}</li>
          </Show>
        </ol>
      </Show>
    </figure>
  );
}
