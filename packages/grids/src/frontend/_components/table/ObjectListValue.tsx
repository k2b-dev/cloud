import type { DateContext } from "@k2b/stdlib";
import { Button, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { ObjectListConfigSchema } from "../../../field-types/object-list";
import { formatCell } from "./format-cell";
import { tableMessages } from "./messages";

/** Display the supplied snapshot. In particular, never recompute finalized cells. */
export function ObjectListValue(props: { value: unknown; config: unknown; detail: boolean; dateConfig?: DateContext }) {
  const locale = useLocale();
  const t = () => tableMessages.resolve([locale()]).t;
  const config = createMemo(() => {
    const parsed = ObjectListConfigSchema.safeParse(props.config);
    return parsed.success ? parsed.data : null;
  });
  const rows = createMemo((): Record<string, unknown>[] =>
    Array.isArray(props.value)
      ? props.value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row))
      : [],
  );
  const valid = () => config() && Array.isArray(props.value) && rows().length === props.value.length;
  const [visible, setVisible] = createSignal(25);
  const [showDetails, setShowDetails] = createSignal(false);
  return (
    <Show when={valid()} fallback={<span class="text-dimmed">{t().listUnavailable}</span>}>
      <Show when={props.detail} fallback={<span>{t().listRows({ count: rows().length })}</span>}>
        <div class="flex min-w-0 flex-col gap-4">
          <p class="text-sm text-dimmed">{t().listRows({ count: rows().length })}</p>
          <Show when={config()?.fields.some((column) => column.detailsOnly)}>
            <div><Button type="button" variant="ghost" aria-expanded={showDetails()} onClick={() => setShowDetails(!showDetails())}>
              {t().listCalculationDetails}<i class={showDetails() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
            </Button></div>
          </Show>
          <For each={rows().slice(0, visible())}>
            {(row, index) => (
              <section class="min-w-0" aria-label={t().listRow({ number: index() + 1 })}>
                <dl class="grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                  <For each={config()?.fields.filter((column) => !column.detailsOnly || showDetails()) ?? []}>
                    {(column) => (
                      <div class="min-w-0">
                        <dt class="text-sm text-dimmed">{column.name}</dt>
                        <dd class="whitespace-pre-wrap break-words tabular-nums">
                          {formatCell(row[column.id], column.type, column.config, undefined, props.dateConfig, locale()) || "—"}
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
          <Show when={rows().length > visible()}>
            <div>
              <Button type="button" variant="input" onClick={() => setVisible((count) => count + 25)}>
                {t().listShowMore}
              </Button>
            </div>
          </Show>
        </div>
      </Show>
    </Show>
  );
}
