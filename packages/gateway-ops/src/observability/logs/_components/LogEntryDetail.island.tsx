import { formatDateTime } from "@k2b/cloud/shared";
import { Button, CopyButton, type LogTableEntry, StatusBadge, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { gatewayOpsMessages } from "../../../messages";
import { LEVEL } from "./log-levels";

/** Metadata as a key list, or as raw JSON to copy. */
function MetadataDetail(props: { metadata: Record<string, unknown> | null }) {
  const { t } = gatewayOpsMessages.resolve([useLocale()()]);
  if (!props.metadata) return null;

  const entries = Object.entries(props.metadata);
  const jsonRaw = JSON.stringify(props.metadata, null, 2);
  const [showRaw, setShowRaw] = createSignal(false);

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={!showRaw()}
        fallback={
          <div class="relative bg-zinc-100 dark:bg-zinc-800 rounded-md px-3 py-2">
            <pre class="text-[11px] text-secondary whitespace-pre-wrap break-all max-h-64 overflow-y-auto pr-16">{jsonRaw}</pre>
            <div class="absolute top-2 right-2">
              <CopyButton text={jsonRaw} label={t.copy} />
            </div>
          </div>
        }
      >
        <div class="bg-zinc-100 dark:bg-zinc-800 rounded-md px-3 py-2">
          <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
            {entries.map(([key, value]) => {
              const isComplex = typeof value === "object" && value !== null;
              const display = isComplex ? JSON.stringify(value) : String(value ?? "null");
              return (
                <>
                  <span class="text-dimmed font-medium shrink-0">{key}</span>
                  <span class={`text-secondary break-all ${isComplex ? "font-mono text-[11px]" : ""}`}>{display}</span>
                </>
              );
            })}
          </div>
        </div>
      </Show>
      <Button type="button" variant="ghost" size="xs" class="self-start" onClick={() => setShowRaw(!showRaw())}>
        {showRaw() ? t.viewFormatted : t.viewRaw}
      </Button>
    </div>
  );
}

/** One log entry in the detail column beside the list. */
export default function LogEntryDetail(props: { entry: LogTableEntry; timeZone: string }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const level = LEVEL[props.entry.level];
  return (
    <div class="flex max-w-2xl flex-col gap-4 px-[var(--ui-space-shell)] pb-[var(--ui-space-shell)]">
      <p class="whitespace-pre-wrap break-words text-sm text-primary">{props.entry.message}</p>
      <dl class="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-dimmed">{t.level}</dt>
        <dd>
          <StatusBadge tone={level?.tone ?? "neutral"} label={level?.label ?? props.entry.level} icon={level?.icon} />
        </dd>
        <dt class="text-dimmed">{t.source}</dt>
        <dd class="text-primary">{props.entry.source}</dd>
        <dt class="text-dimmed">{t.time}</dt>
        <dd class="text-primary">{formatDateTime(props.entry.createdAt, { locale: locale(), timeZone: props.timeZone })}</dd>
      </dl>
      <Show when={props.entry.metadata}>
        <section class="flex flex-col gap-1">
          <h3 class="text-sm font-semibold text-primary">{t.metadata}</h3>
          <MetadataDetail metadata={props.entry.metadata} />
        </section>
      </Show>
    </div>
  );
}
