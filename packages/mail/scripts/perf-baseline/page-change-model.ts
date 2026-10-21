import { z } from "zod";

export const pageChangeIds = ["overview-mailbox", "mailbox-automations", "automations-mailbox"] as const;
export type PageChangeId = (typeof pageChangeIds)[number];
const ms = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();
export const pageChangeSampleSchema = z.object({
  clickToMainMs: ms,
  clickToFirstActionMs: ms,
  documentLoad: z.boolean(),
  panelReloaded: z.boolean().nullable(),
  panelContextMs: ms.nullable(),
  panelStatus: z.enum(["observed", "unavailable-phone"]),
  htmlBytes: count,
  jsBytes: count,
  cssBytes: count,
  /** Actual encoded transfer for eager script URLs, not decoded body size. */
  eagerJsTransferBytes: count,
});
export type PageChangeSample = z.infer<typeof pageChangeSampleSchema>;
export const resourceCountsSchema = z.object({
  windowListeners: count,
  documentListeners: count,
  timeouts: count,
  intervals: count,
  eventSources: count,
  webSockets: count,
});
export const sequenceSnapshotSchema = resourceCountsSchema.extend({
  changes: count,
  heapUsedBytes: count,
  domNodes: count,
  jsEventListeners: count,
});
export const pageChangesSchema = z.object({
  /** Fixed decision references; measuring today's document loads never moves these gates. */
  gates: z.object({ desktopMs: z.literal(203), phoneMs: z.literal(821), panelChanges: z.literal(20) }),
  profiles: z.array(
    z.object({
      id: z.enum(pageChangeIds),
      browser: z.enum(["chromium", "webkit"]),
      profile: z.enum(["desktop", "phone"]),
      cache: z.enum(["cold", "warm"]),
      status: z.enum(["ok", "failed", "skipped"]),
      reason: z.string().nullable(),
      samples: z.array(pageChangeSampleSchema),
    }),
  ),
  sequence: z.object({
    status: z.enum(["ok", "failed", "skipped"]),
    reason: z.string().nullable(),
    snapshots: z.array(sequenceSnapshotSchema),
    first20PanelReloads: count,
    first20DocumentLoads: count,
  }),
});
export type PageChanges = z.infer<typeof pageChangesSchema>;

/** A warm label is evidence, not an intention. A missing eager script is a broken probe too. */
export function requireWarmCache(resources: { name: string; transferSize: number }[], eager: string[]) {
  if (!eager.length) throw new Error("Warm cache guard: no eager JavaScript URLs captured");
  for (const url of eager) {
    const entries = resources.filter((entry) => entry.name === url);
    if (!entries.length) throw new Error(`Warm cache guard: missing eager script ${new URL(url).pathname}`);
    if (entries.some((entry) => entry.transferSize !== 0))
      throw new Error(`Warm cache guard: eager JavaScript transferred bytes: ${new URL(url).pathname}`);
  }
  return 0;
}

export function renderPageChanges(result: PageChanges) {
  const median = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return (sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2).toFixed(1);
  };
  return [
    "## Mail page changes",
    "",
    "Fixed pilot limits: 203 ms desktop / 821 ms phone for both main content and first action. Historical document references: 406 / 1,642 ms. Rows below measure this build, including actual document loads before Mail opts in. First action includes the automation driver's dispatch delay; it is an upper bound, never a TTI proxy.",
    "",
    "| Change | Browser/profile/cache | Status | Main ms | First action ms | Document loads | Panel reloads | Panel context ms | HTML/JS/CSS B (median) |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...result.profiles.map((row) => {
      const samples = row.samples;
      if (row.status !== "ok" || !samples.length)
        return `| ${row.id} | ${row.browser}/${row.profile}/${row.cache} | ${row.status}: ${(row.reason ?? "no samples").replaceAll("|", "/").replaceAll("\n", " ")} | — | — | — | — | — | — |`;
      const panels = samples.flatMap((s) => (s.panelContextMs === null ? [] : [s.panelContextMs]));
      return `| ${row.id} | ${row.browser}/${row.profile}/${row.cache} | ok | ${median(samples.map((s) => s.clickToMainMs))} | ${median(samples.map((s) => s.clickToFirstActionMs))} | ${samples.filter((s) => s.documentLoad).length}/${samples.length} | ${samples[0]!.panelStatus === "observed" ? `${samples.filter((s) => s.panelReloaded).length}/${samples.length}` : "unavailable (phone)"} | ${panels.length ? median(panels) : "—"} | ${["htmlBytes", "jsBytes", "cssBytes"].map((key) => median(samples.map((s) => s[key as "htmlBytes" | "jsBytes" | "cssBytes"]))).join(" / ")} |`;
    }),
    "",
    `Sequence (Chromium desktop, warm): ${result.sequence.status}${result.sequence.reason ? ` — ${result.sequence.reason}` : ""}. First 20 changes: ${result.sequence.first20DocumentLoads} document loads, ${result.sequence.first20PanelReloads} panel reloads. Full document loads reset the heap; those observations cannot establish swap cleanup.`,
    "",
    "| Changes | Heap after GC B | DOM nodes | All DOM listeners | Window/document listeners | Timeouts/intervals | EventSource/WebSocket |",
    "| ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...result.sequence.snapshots.map(
      (s) =>
        `| ${s.changes} | ${s.heapUsedBytes} | ${s.domNodes} | ${s.jsEventListeners} | ${s.windowListeners}/${s.documentListeners} | ${s.timeouts}/${s.intervals} | ${s.eventSources}/${s.webSockets} |`,
    ),
    "",
  ];
}
