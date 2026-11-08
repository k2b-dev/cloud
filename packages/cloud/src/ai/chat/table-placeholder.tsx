import { CopyButton, Skeleton, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import type { CloudAiViewSummary } from "../view-block";
import { aiChatMessages } from "./messages";
import { ViewHeading } from "./view-heading";

export type TableSummary = Extract<CloudAiViewSummary, { view: "table" }>;

/** Rows a table shows inline, as capability tables do; sorting and Copy data use all of them. */
const VISIBLE_ROWS = 100;
/** Rows the viewport shows before it scrolls; it reserves their height from the first frame. */
const VIEWPORT_ROWS = 8;
/** A compact DataTable row and its totals row, and the quieter header row above them. */
const ROW_REM = 2.5;
const HEADER_REM = 2.125;
/** DataTable draws a hairline between rows only above this many columns. */
const HAIRLINE_ABOVE_COLUMNS = 8;

/**
 * The header row, the rows up to the viewport's, and the totals row when there is one, inside the paper's 1px frame.
 * Wide tables add a 1px hairline after each visible body row with a following body row; the footer adds none.
 */
export const tableHeight = (summary: TableSummary) => {
  const bodyRows = Math.max(1, Math.min(summary.rows, VIEWPORT_ROWS));
  const rows = bodyRows + Number(summary.footer);
  const lines = summary.columns > HAIRLINE_ABOVE_COLUMNS ? bodyRows - 1 + Number(summary.rows > VIEWPORT_ROWS) : 0;
  return `calc(${HEADER_REM + rows * ROW_REM}rem + ${2 + lines}px)`;
};

/** The same frame before the table code arrives, on the server and in the first browser render. */
export function CloudTablePlaceholder(props: { id: string; summary: TableSummary; loading: boolean }) {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const number = () => new Intl.NumberFormat(locale());
  return (
    <section class="grid min-w-0 gap-3" aria-labelledby={props.id}>
      <ViewHeading
        id={props.id}
        title={props.summary.title}
        subtitle={props.summary.subtitle}
        actions={
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <Show when={props.summary.search || props.summary.grouped}>
              <div class="k2b-data-table-tools" aria-hidden="true">
                <Show when={props.summary.search}>
                  <Skeleton class="k2b-data-table-tools__search h-9" />
                </Show>
                <Show when={props.summary.grouped}>
                  <Skeleton class="k2b-data-table-tools__group h-9" />
                </Show>
              </div>
            </Show>
            <CopyButton text="" label={t().viewCopyData} iconOnly size="sm" variant="ghost" disabled />
          </div>
        }
      />
      <div class="min-w-0" style={{ height: tableHeight(props.summary) }}>
        <div role="status" class="flex h-full items-center justify-center text-center text-xs text-dimmed">
          {props.loading ? t().viewLoading : t().viewUnavailable}
        </div>
      </div>
      <Show when={props.summary.rows > VISIBLE_ROWS}>
        <p class="text-sm text-secondary">
          {t().viewRowsCapped({ shown: number().format(VISIBLE_ROWS), total: number().format(props.summary.rows) })}
        </p>
      </Show>
    </section>
  );
}
