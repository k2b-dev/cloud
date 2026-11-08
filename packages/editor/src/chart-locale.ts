import { z } from "zod";

/** BCP 47 locale strings must be accepted by every Intl formatter used during rendering. */
export const chartLocaleSchema = () =>
  z
    .string()
    .min(1)
    .refine((value) => {
      try {
        return Intl.getCanonicalLocales(value).length === 1;
      } catch {
        return false;
      }
    }, "Use a valid BCP 47 locale, such as de-DE.");

/** The portable renderers which honour an explicit locale. Keep one policy for single charts and groups. */
const localeKinds = new Set(["sankey", "treemap", "pareto", "bubble", "radar"]);
export const chartAcceptsLocale = (chart: { kind?: string; layout?: string }): boolean =>
  chart.kind === "heatmap" ? chart.layout === "calendar" : localeKinds.has(chart.kind ?? "");
