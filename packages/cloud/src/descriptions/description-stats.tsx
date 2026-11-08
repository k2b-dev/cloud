import { i18n } from "@k2b/stdlib";
import { type DashboardFrameState, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { For, type JSX } from "solid-js";
import { type DescriptionObject, descriptionList, descriptionObject, descriptionText } from "./description-table";
import { formatDescriptionNumber } from "./format";
import type { DescriptionJson as JsonValue } from "./json";

/** The words of key figures without data or no longer current; capability views draw key figures without the panel's catalog. */
const statsMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      nothingCounted: "Nothing counted in this period",
      asOfNotCurrent: ({ asOf }: { asOf: string }) => `As of ${asOf} · not current`,
      notCurrent: "Not current",
    },
    de: {
      nothingCounted: "In diesem Zeitraum nichts gezählt",
      asOfNotCurrent: ({ asOf }) => `Stand ${asOf} · nicht aktuell`,
      notCurrent: "Nicht aktuell",
    },
  },
});

/**
 * `{ block: "stats", items: [...] }`: single key-figure tiles. Every tile has the states in its own place: loading
 * placeholders, "Not loaded" with Try again, the empty dash, and a stale note under the figure.
 */
export function StatsBlock(props: {
  spec: DescriptionObject;
  state: DashboardFrameState;
  asOf?: string;
  onRetry?: () => void;
}): JSX.Element {
  const locale = useLocale();
  const t = () => statsMessages.resolve([locale()]).t;
  const items = () => descriptionList(props.spec.items).filter(descriptionObject);
  // The icon tones of a key figure, and the money tones `in` and `out` of `FlowAmount`.
  const tones = ["blue", "emerald", "amber", "red", "zinc", "in", "out"] as const;
  const tone = (value: JsonValue | undefined) => tones.find((entry) => entry === value);
  return (
    <StatGrid columns={Math.min(6, Math.max(1, items().length)) as 1 | 2 | 3 | 4 | 5 | 6}>
      <For each={items()}>
        {(item) => {
          const format = (value: number) => formatDescriptionNumber(value, item.format, locale());
          const delta = () => {
            const change = descriptionObject(item.delta) ? item.delta : undefined;
            if (!change || typeof change.value !== "number") return undefined;
            return {
              value: change.value,
              ...(change.unit === "points" ? { unit: "points" as const } : {}),
              ...(change.better === "up" ? { better: "up" as const } : change.better === "down" ? { better: "down" as const } : {}),
            };
          };
          const compare = () =>
            descriptionObject(item.compare) && typeof item.compare.value === "number"
              ? { label: descriptionText(item.compare.label), value: format(item.compare.value) }
              : undefined;
          const empty = () => props.state === "empty";
          return (
            <StatCell
              label={descriptionText(item.label)}
              icon={typeof item.icon === "string" ? item.icon : undefined}
              tone={tone(item.tone)}
              value={empty() ? null : typeof item.value === "number" ? format(item.value) : descriptionText(item.value)}
              sub={empty() ? t().nothingCounted : compare() ? undefined : descriptionText(item.note) || undefined}
              delta={empty() ? undefined : delta()}
              compare={empty() ? undefined : compare()}
              trend={descriptionList(item.trend).filter((value): value is number => typeof value === "number")}
              status={props.state === "loading" ? "loading" : props.state === "error" ? "error" : undefined}
              stale={props.state === "stale" ? (props.asOf ? t().asOfNotCurrent({ asOf: props.asOf }) : t().notCurrent) : undefined}
              onRetry={props.onRetry}
            />
          );
        }}
      </For>
    </StatGrid>
  );
}
