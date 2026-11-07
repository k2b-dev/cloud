import { balanceFlowTooltip } from "../charts/core/balance-flow";
import {
  type ChartDatumRef,
  type ChartSelection,
  type ChartTooltipFormatter,
  isChartDatum,
  sameChartDatum,
} from "../charts/core/inspection";
import { inspectChart } from "./chart-inspection-core";

export function selectBalanceFlowDatum(root: HTMLElement, selected: ChartDatumRef | null): void {
  for (const mark of root.querySelectorAll<SVGElement>("[data-chart-datum]")) {
    const datum: unknown = JSON.parse(mark.getAttribute("data-chart-datum") ?? "null");
    const active = Boolean(selected && isChartDatum(datum) && sameChartDatum(datum, selected));
    mark.toggleAttribute("data-selected", active);
    if (active)
      mark.style.setProperty(
        "--k2b-chart-selection-color",
        mark.querySelector("rect")?.getAttribute("fill") ?? "var(--k2b-balance-flow-mark,#3b82f6)",
      );
    else mark.style.removeProperty("--k2b-chart-selection-color");
  }
}
/** Enhances the server frame in place; neither resize nor initial mount replaces its drawing. */
export function mountBalanceFlow(
  root: HTMLElement,
  options: {
    locale?: string;
    select?: (value: ChartSelection) => void;
    tooltip?: ChartTooltipFormatter;
    retry?: () => void;
    periodChange?: (index: number) => void;
    viewChange?: (view: "chart" | "table") => void;
  } = {},
): () => void {
  const chart = root.querySelector<HTMLElement>('.k2b-chart[data-chart-kind="balanceFlow"]');
  if (!chart || root.hasAttribute("data-balance-mounted")) return () => {};
  root.setAttribute("data-balance-mounted", "");
  const locale = root.dataset.locale ?? options.locale ?? "en";
  const svgHost = chart.querySelector<HTMLElement>(".k2b-chart__svg")!;
  const templates = Array.from(root.querySelectorAll<HTMLTemplateElement>("template[data-balance-template]"));
  let period = Number(root.dataset.period) || 0;
  const animations = new Set<Animation>();
  const inspection = inspectChart(chart, {
    kind: "balanceFlow",
    locale,
    format: options.tooltip ?? (({ datum }) => balanceFlowTooltip(datum, locale)),
    select: (selection) => {
      selectBalanceFlowDatum(root, selection.datum);
      options.select?.(selection);
    },
  });
  const listen = <K extends keyof HTMLElementEventMap>(event: K, listener: (value: HTMLElementEventMap[K]) => void) => {
    root.addEventListener(event, listener);
    return () => root.removeEventListener(event, listener);
  };
  const play = (element: Element, frames: Keyframe[], duration: number) => {
    const animation = element.animate(frames, { duration, easing: "cubic-bezier(.2,.7,.2,1)", fill: "none" });
    animations.add(animation);
    void animation.finished.catch(() => {}).finally(() => animations.delete(animation));
  };
  const move = (delta: number) => {
    const next = period + delta,
      template = templates[next];
    if (!template || !["data", "stale"].includes(root.dataset.state ?? "data")) return;
    inspection.close();
    for (const a of animations) a.cancel();
    const oldNode = chart.querySelector<SVGGraphicsElement>(`[data-balance-key="${delta > 0 ? "closing" : "opening"}"]`);
    const oldBox = oldNode?.getBoundingClientRect();
    period = next;
    root.dataset.period = String(period);
    options.periodChange?.(period);
    svgHost.innerHTML = template.content.querySelector("[data-balance-diagram]")!.innerHTML;
    root.querySelector("[data-balance-table]")!.innerHTML = template.content.querySelector("[data-balance-table-template]")!.innerHTML;
    root.querySelector("[data-balance-phone]")!.innerHTML = template.content.querySelector("[data-balance-phone-template]")!.innerHTML;
    root.querySelector("[data-balance-label]")!.textContent = template.dataset.label ?? "";
    root.querySelector("[data-balance-summary]")!.textContent = template.dataset.summary ?? "";
    chart.setAttribute("aria-label", template.dataset.summary ?? "");
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-balance-step]"))
      button.disabled = Number(button.dataset.balanceStep) < 0 ? period === 0 : period === templates.length - 1;
    selectBalanceFlowDatum(root, null);
    inspection.invalidate();
    if (!root.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches && root.dataset.view !== "table") {
      const incoming = chart.querySelector<SVGGraphicsElement>(`[data-balance-key="${delta > 0 ? "opening" : "closing"}"]`);
      if (incoming && oldBox) {
        const box = incoming.getBoundingClientRect(),
          matrix = incoming.getScreenCTM();
        if (matrix && box.width && box.height) {
          // The same balance bar travels from the previous closing position to the new opening position.
          play(
            incoming,
            [
              {
                transform: `translate(${(oldBox.x - box.x) / matrix.a}px,${(oldBox.y - box.y) / matrix.d}px) scaleY(${oldBox.height / box.height})`,
                transformOrigin: `${incoming.getAttribute("x")}px ${incoming.getAttribute("y")}px`,
              },
              { transform: "none" },
            ],
            320,
          );
        }
      }
      const bands = chart.querySelectorAll(".k2b-balance-flow-band");
      for (const band of bands)
        play(
          band,
          [
            { opacity: 0.45, transform: `translateX(${delta * 16}px)` },
            { opacity: 1, transform: "none" },
          ],
          320,
        );
    }
  };
  const cleanups = [
    listen("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      if (!target || target.disabled) return;
      if (target.dataset.balanceStep) move(Number(target.dataset.balanceStep));
      if (target.dataset.balanceView) {
        inspection.close();
        const table = target.dataset.balanceView === "table";
        root.dataset.view = table ? "table" : "chart";
        chart.hidden = table;
        root.querySelector<HTMLElement>("[data-balance-phone]")!.hidden = table;
        root.querySelector<HTMLElement>("[data-balance-table]")!.hidden = !table;
        options.viewChange?.(table ? "table" : "chart");
        for (const button of root.querySelectorAll("[data-balance-view]")) button.setAttribute("aria-pressed", String(button === target));
      }
      if (target.hasAttribute("data-balance-retry")) options.retry?.();
    }),
  ];
  // Capture prevents the shared inspector from consuming left/right before period navigation.
  const key = (event: KeyboardEvent) => {
    if (!event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      move(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  root.addEventListener("keydown", key, true);
  return () => {
    root.removeEventListener("keydown", key, true);
    cleanups.forEach((fn) => fn());
    for (const a of animations) a.cancel();
    inspection.destroy();
    root.removeAttribute("data-balance-mounted");
  };
}
