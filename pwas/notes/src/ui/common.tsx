import { For, type JSX, Show } from "solid-js";
import { BRAND } from "../brand";
import type { ChartPreview } from "../lib/model";
import { preferences } from "../prefs";
import { t } from "../state";

const TAG_COLORS = ["--t-emerald", "--t-blue", "--t-orange", "--t-rose", "--t-lime", "--t-fuchsia", "--t-violet", "--t-teal", "--t-amber", "--t-zinc"];

/** A tag keeps its colour everywhere: the same name always lands on the same palette entry. */
export function tagColor(tag: string): string {
  let hash = 0;
  for (const char of tag) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `var(${TAG_COLORS[hash % TAG_COLORS.length]})`;
}

export function Wordmark(props: { href?: string }) {
  return (
    <a class="n-wordmark" href={props.href ?? "/"}>
      <img src="/cloud-logo.svg" alt="" />
      {BRAND}
    </a>
  );
}

/** Splits a message at `{cloud}` so the word can carry the underline in the brand colour. */
export function WithCloud(props: { text: string }) {
  const parts = () => props.text.split("{cloud}");
  return (
    <>
      {parts()[0]}
      <u>{t().cloud}</u>
      {parts()[1]}
    </>
  );
}

export const CLOUD_URL = "https://github.com/k2b-dev/cloud";

export function Footer(props: { narrow?: boolean; onReport?: () => void }) {
  return (
    <footer class="n-foot" data-narrow={props.narrow ? "" : undefined}>
      <a class="n-cloud" href={CLOUD_URL} rel="noopener" target="_blank">
        <img src="/cloud-logo.svg" alt="" />
        <span>
          {BRAND} <WithCloud text={t().builtWith} />
        </span>
      </a>
      <a href="/datenschutz">{t().privacy}</a>
      <a href="/nutzungsbedingungen">{t().terms}</a>
      <a href="/impressum">{t().imprint}</a>
      <Show when={props.onReport}>{(report) => <button type="button" onClick={() => report()()}>{t().reportContent}</button>}</Show>
    </footer>
  );
}

/** "vor 2 Std.", "gestern", "Mo.", "24.10." — short enough for a card footer. */
export function when(timestamp: number, now = Date.now()): string {
  const locale = preferences.locale();
  const minutes = Math.round((now - timestamp) / 60_000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes < 1) return relative.format(0, "minute");
  if (minutes < 60) return relative.format(-minutes, "minute");
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const date = new Date(timestamp);
  if (timestamp >= today.getTime()) return relative.format(-Math.round(minutes / 60), "hour");
  const days = Math.ceil((today.getTime() - timestamp) / 86_400_000);
  if (days <= 1) return relative.format(-1, "day");
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  if (date.getFullYear() === today.getFullYear()) return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(date);
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

export function MiniChart(props: { chart: ChartPreview; class?: string }) {
  const values = () => props.chart.values.slice(0, 24);
  const max = () => Math.max(...values().map((value) => Math.abs(value)), 1);
  const area = () => {
    const w = 220;
    const h = 64;
    const pad = 4;
    const list = values();
    const step = list.length > 1 ? (w - pad * 2) / (list.length - 1) : 0;
    const points = list.map((value, index) => [pad + index * step, h - (Math.max(value, 0) / max()) * (h - pad * 2) - pad] as const);
    const line = points.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(" ");
    const last = points.at(-1);
    const first = points[0];
    return { line, fill: last && first ? `${line} L ${last[0]} ${h} L ${first[0]} ${h} Z` : "" };
  };
  return (
    <svg class={props.class ?? "n-mini"} viewBox="0 0 220 64" preserveAspectRatio="none" aria-hidden="true">
      <Show
        when={props.chart.kind === "line" && values().length > 1}
        fallback={
          <For each={values()}>
            {(value, index) => {
              const width = 220 / Math.max(values().length, 1);
              const height = (Math.max(value, 0) / max()) * 62;
              return (
                <rect
                  x={index() * width + width * 0.14}
                  y={64 - height}
                  width={width * 0.7}
                  height={height}
                  rx="3"
                  fill="color-mix(in srgb, var(--t-blue) 55%, transparent)"
                />
              );
            }}
          </For>
        }
      >
        <path d={area().fill} fill="color-mix(in srgb, var(--t-blue) 14%, transparent)" />
        <path d={area().line} fill="none" stroke="var(--t-blue)" stroke-width="2" vector-effect="non-scaling-stroke" />
      </Show>
    </svg>
  );
}

export type IconName = `ti-${string}`;

/** `name` is the full Tabler class ("ti-search"), so the build finds every glyph it has to ship. */
export function Icon(props: { name: IconName; class?: string }): JSX.Element {
  return <i class={`ti ${props.name}${props.class ? ` ${props.class}` : ""}`} aria-hidden="true" />;
}
