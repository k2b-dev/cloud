import {
  type BalanceFlowOptions,
  balanceFlowDirection,
  balanceFlowDisplayAmount,
  balanceFlowRows,
  balanceFlowSummary,
  balanceFlowWords,
  renderBalanceFlowSvg,
} from "./balance-flow";
import { BalanceFlowError, balanceFlowHeight } from "./balance-flow-size";
import { escapeXml } from "./svg";

export type BalanceFlowState = "data" | "loading" | "empty" | "error" | "stale";
/** SSR-complete continuous canvas; reversed flex origin reveals the newest month without script. */
export function renderBalanceFlowHtml(
  spec: BalanceFlowOptions,
  state: BalanceFlowState = "data",
  error?: string,
  view: "chart" | "table" = "chart",
  retry = false,
  standalone = true,
): string {
  const t = balanceFlowWords(spec.locale),
    active = Math.max(0, spec.periods.length - 1),
    height = balanceFlowHeight(spec.periods, spec.height);
  let diagram = "";
  try {
    diagram = renderBalanceFlowSvg({ ...spec, title: undefined, subtitle: undefined, inspect: true }).replace(
      "<svg ",
      '<svg preserveAspectRatio="none" ',
    );
  } catch (issue) {
    state = "error";
    error = issue instanceof BalanceFlowError ? `${issue.periodLabel}: ${t.balanceInvalid}` : t.balanceInvalid;
  }
  if (!spec.periods.length && state !== "loading" && state !== "error") state = "empty";
  const shown = state === "data" || state === "stale",
    p = spec.periods[active];
  const table = (index: number) =>
    `<table class="k2b-balance-flow__table"><caption>${escapeXml(spec.periods[index]?.label ?? "")}</caption><thead><tr><th scope="col">${escapeXml(t.chartFields({ key: "detail" }))}</th><th scope="col">${escapeXml(t.balancePeriod)}</th><th scope="col">${escapeXml(t.balanceDirection)}</th><th scope="col">${escapeXml(spec.valueLabel ?? t.chartFields({ key: "value" }))}</th></tr></thead><tbody>${balanceFlowRows(
      spec,
      index,
    )
      .map(
        (row) =>
          `<tr data-direction="${row.direction}"><th scope="row">${escapeXml(row.label)}</th><td>${escapeXml(spec.periods[index]?.label ?? "")}</td><td>${escapeXml(balanceFlowDirection(row.direction, spec.locale))}</td><td class="num">${escapeXml(balanceFlowDisplayAmount(spec, row))}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  const phone = (index: number) =>
    `<dl class="k2b-balance-flow__amounts" data-balance-phone-period="${index}"${index === active ? "" : " hidden"}>${balanceFlowRows(
      spec,
      index,
    )
      .map(
        (row) =>
          `<div data-direction="${row.direction}"><dt>${escapeXml(row.label)}</dt><dd>${escapeXml(balanceFlowDisplayAmount(spec, row))}</dd></div>`,
      )
      .join("")}</dl>`;
  const status = state === "loading" ? t.chartLoading : state === "error" ? (error ?? t.balanceInvalid) : t.balanceEmpty;
  return `<section class="${standalone ? "k2b-ui " : ""}k2b-balance-flow" data-balance-flow data-period="${active}" data-locale="${escapeXml(spec.locale ?? "en")}" data-view="${view}" data-state="${state}" style="--k2b-balance-flow-height:${height}px;--k2b-balance-period-width:${Math.max(620, spec.width ?? 620)}px;--k2b-balance-flow-rows:${Math.max(2, ...spec.periods.map((p) => p.inflows.length + p.outflows.length + 3))}" aria-busy="${state === "loading"}">
<header class="k2b-balance-flow__header"><div>${spec.title ? `<h3 title="${escapeXml(spec.title)}">${escapeXml(spec.title)}</h3>` : ""}<div class="k2b-balance-flow__subtitle" role="status">${escapeXml(state === "stale" ? t.balanceStale : (spec.subtitle ?? ""))}</div></div><div class="k2b-balance-flow__views" role="group" aria-label="${escapeXml(t.chartView)}"><button type="button" data-balance-view="chart" aria-pressed="${view === "chart"}">${escapeXml(t.chartDiagram)}</button><button type="button" data-balance-view="table" aria-pressed="${view === "table"}">${escapeXml(t.chartData)}</button></div></header>
<nav class="k2b-balance-flow__nav" aria-label="${escapeXml(t.balancePeriod)}"><button type="button" data-balance-step="-1" aria-label="${escapeXml(t.balancePrevious)}"${!shown || active === 0 ? " disabled" : ""}>‹</button><strong data-balance-label>${escapeXml(p?.label ?? "—")}</strong><button type="button" data-balance-step="1" aria-label="${escapeXml(t.balanceNext)}"${!shown || active >= spec.periods.length - 1 ? " disabled" : ""}>›</button></nav>
<div class="k2b-balance-flow__content"><div class="k2b-balance-flow__content-box"><div class="k2b-balance-flow__status" role="${state === "error" ? "alert" : "status"}"${shown ? " hidden" : ""}><p>${escapeXml(status)}</p>${state === "error" && retry ? `<button type="button" data-balance-retry>${escapeXml(t.balanceRetry)}</button>` : ""}</div><div class="k2b-balance-flow__data"${shown ? "" : " hidden"}>
<div class="k2b-chart" data-chart-kind="balanceFlow"${view === "table" ? " hidden" : ""} tabindex="0" role="group" aria-label="${escapeXml(spec.title ?? t.balancePeriod)}" aria-description="${escapeXml(t.balanceKeyboard)}">
<div class="k2b-balance-flow__scroll" data-balance-scroll><div class="k2b-balance-flow__track" style="--k2b-balance-periods:${Math.max(1, spec.periods.length)}">
<div class="k2b-balance-flow__months">${spec.periods.map((period, i) => `<div data-balance-month="${i}"${i === active ? " data-balance-active" : ""} data-label="${escapeXml(period.label)}" data-summary="${escapeXml(balanceFlowSummary(spec, i))}"><strong>${escapeXml(period.label)}</strong></div>`).join("")}</div>
<div class="k2b-chart__svg">${diagram}</div></div></div></div>
<div data-balance-table${view === "table" ? "" : " hidden"}>${spec.periods.map((_, i) => table(i)).join("")}</div><div data-balance-phone${view === "table" ? " hidden" : ""}>${spec.periods.map((_, i) => phone(i)).join("")}</div></div></div></div>
<div class="k2b-sr-only" data-balance-summaries${shown ? "" : " hidden"}>${spec.periods.map((_, i) => `<p>${escapeXml(balanceFlowSummary(spec, i))}</p>`).join("")}</div>
<p class="k2b-sr-only" data-balance-summary role="status">${escapeXml(shown && p ? balanceFlowSummary(spec, active) : status)}</p>
</section>`;
}
