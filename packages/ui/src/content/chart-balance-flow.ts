import { balanceFlowTooltip } from "../charts/core/balance-flow-data";
import {
  type ChartDatumRef,
  type ChartSelection,
  type ChartTooltipFormatter,
  isChartDatum,
  sameChartDatum,
} from "../charts/core/inspection";
import { prefersReducedMotion } from "../motion";
import { inspectChart } from "./chart-inspection-mount";

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
  const viewport = root.querySelector<HTMLElement>("[data-balance-scroll]")!;
  const months = Array.from(root.querySelectorAll<HTMLElement>("[data-balance-month]"));
  let period = Number(root.dataset.period) || 0;
  let animation: Animation | undefined;
  const inspection = inspectChart(chart, {
    kind: "balanceFlow",
    nav: {
      last: true,
      pointer: false,
      keepScroll: true,
      reveal: (element) => element.scrollIntoView({ block: "nearest", inline: "nearest" }),
    },
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
  const update = (next: number) => {
    period = next;
    root.dataset.period = String(period);
    options.periodChange?.(period);
    for (const [index, month] of months.entries()) month.toggleAttribute("data-balance-active", index === period);
    root.querySelector("[data-balance-label]")!.textContent = months[period]?.textContent ?? "";
    root.querySelector("[data-balance-summary]")!.textContent =
      chart.querySelector(`[data-balance-period="${period}"]`)?.getAttribute("aria-label") ?? "";
    for (const list of root.querySelectorAll<HTMLElement>("[data-balance-phone-period]"))
      list.hidden = Number(list.dataset.balancePhonePeriod) !== period;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-balance-step]"))
      button.disabled = Number(button.dataset.balanceStep) < 0 ? period === 0 : period === months.length - 1;
  };
  const targetScroll = (index: number) =>
    Math.max(
      viewport.clientWidth - viewport.scrollWidth,
      Math.min(
        0,
        viewport.scrollLeft +
          months[index]!.getBoundingClientRect().right -
          viewport.getBoundingClientRect().right +
          Number.parseFloat(getComputedStyle(viewport).getPropertyValue("--k2b-balance-peek")),
      ),
    );
  const scrolled = () => {
    if (!months.length || animation) return;
    const nearest = months.reduce(
      (best, _, i) => (Math.abs(targetScroll(i) - viewport.scrollLeft) < Math.abs(targetScroll(best) - viewport.scrollLeft) ? i : best),
      0,
    );
    if (nearest !== period) update(nearest);
  };
  const cancelMotion = () => {
    const previous = animation;
    animation = undefined;
    previous?.cancel();
    viewport.style.removeProperty("scroll-snap-type");
    root.removeAttribute("data-balance-scrolling");
  };
  const move = (delta: number) => {
    const next = period + delta,
      month = months[next];
    if (!month || !["data", "stale"].includes(root.dataset.state ?? "data")) return;
    inspection.close();
    cancelMotion();
    update(next);
    if (root.dataset.view === "table") {
      const tables = root.querySelectorAll<HTMLTableElement>("[data-balance-table] table");
      const tableHost = root.querySelector<HTMLElement>("[data-balance-table]")!;
      tableHost.scrollTop = tables[next]!.offsetTop - tableHost.offsetTop;
      return;
    }
    const from = viewport.scrollLeft,
      to = targetScroll(next);
    const timing = getComputedStyle(root).getPropertyValue("--k2b-motion-base").trim() || "180ms";
    const duration = Number.parseFloat(timing) * (timing.endsWith("ms") ? 1 : 1000);
    if (prefersReducedMotion() || duration <= 0) {
      viewport.scrollLeft = to;
      return;
    }
    // Animate the scroll itself, so the joined band never disappears or changes shape.
    root.setAttribute("data-balance-scrolling", "");
    viewport.style.scrollSnapType = "none";
    animation = viewport.animate([{ opacity: 1 }, { opacity: 1 }], { duration });
    const running = animation;
    const tick = () => {
      if (running.playState !== "running") return;
      const fraction = Math.min(1, Number(running.currentTime ?? 0) / duration);
      const eased = fraction * fraction * (3 - 2 * fraction);
      viewport.scrollLeft = from + (to - from) * eased;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    void running.finished
      .catch(() => {})
      .finally(() => {
        if (animation !== running) return;
        viewport.scrollLeft = to;
        viewport.style.removeProperty("scroll-snap-type");
        animation = undefined;
        root.removeAttribute("data-balance-scrolling");
        update(next);
      });
  };
  viewport.addEventListener("scroll", scrolled, { passive: true });
  const interrupt = () => {
    cancelMotion();
    inspection.close();
  };
  viewport.addEventListener("pointerdown", interrupt, { passive: true });
  viewport.addEventListener("wheel", interrupt, { passive: true });
  // Redraws retain the selected month. A first mount remains at CSS's newest origin.
  const remembered = Number(root.dataset.balanceRestore);
  if (Number.isInteger(remembered) && root.hasAttribute("data-balance-restore") && months[remembered]) {
    viewport.scrollLeft = targetScroll(remembered);
    update(remembered);
  }
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
        if (!table) move(0);
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
    cancelMotion();
    viewport.removeEventListener("scroll", scrolled);
    viewport.removeEventListener("pointerdown", interrupt);
    viewport.removeEventListener("wheel", interrupt);
    inspection.destroy();
    root.removeAttribute("data-balance-mounted");
  };
}
