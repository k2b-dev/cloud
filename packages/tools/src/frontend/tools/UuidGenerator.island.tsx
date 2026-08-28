import { i18n } from "@k2b/stdlib";
import { Button, CopyButton, Slider, useLocale } from "@k2b/ui";
import { createEffect, createSignal, For } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

export const uuidMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      count: "Count",
      countDescription: "Number of UUIDs to generate at once",
      uuidCount: ({ count }: { count: number }) => (count === 1 ? "1 UUID" : `${count} UUIDs`),
      copied: "Copied",
      copyAll: "Copy All",
    },
    de: {
      count: "Anzahl",
      countDescription: "UUIDs pro Durchlauf",
      uuidCount: ({ count }) => (count === 1 ? "1 UUID" : `${count} UUIDs`),
      copied: "Kopiert",
      copyAll: "Alle kopieren",
    },
  },
});

export default function UuidGenerator() {
  const locale = useLocale();
  const t = () => uuidMessages.resolve([locale()]).t;
  const [count, setCount] = createSignal(1);
  const [uuids, setUuids] = createSignal<string[]>([]);
  const [copiedAll, setCopiedAll] = createSignal(false);
  const generate = () => {
    const result: string[] = [];
    for (let i = 0; i < count(); i++) {
      result.push(crypto.randomUUID());
    }
    setUuids(result);
    setCopiedAll(false);
  };
  createEffect(generate);
  const copyAll = async () => {
    await navigator.clipboard.writeText(uuids().join("\n"));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-4">
      <div class="paper p-4 flex flex-col gap-3">
        <Slider
          label={t().count}
          description={t().countDescription}
          value={count}
          onValueChange={setCount}
          min={1}
          max={100}
          step={1}
          showValue
        />
      </div>
      {uuids().length > 0 && (
        <div class="paper flex min-h-0 flex-1 flex-col gap-2 p-4">
          <div class="flex items-center justify-between mb-1">
            <p class="text-xs font-medium text-dimmed">{t().uuidCount({ count: uuids().length })}</p>
            <Button variant="secondary" size="sm" onClick={copyAll}>
              <i class={`ti ${copiedAll() ? "ti-check" : "ti-copy"}`} /> {copiedAll() ? t().copied : t().copyAll}
            </Button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            <For each={uuids()}>
              {(uuid) => (
                <div class="flex items-center gap-2 group">
                  <ToolCodeBlock class="flex-1 px-2 py-1">{uuid}</ToolCodeBlock>
                  <CopyButton text={uuid} class="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 shrink-0" />
                </div>
              )}
            </For>
          </div>
        </div>
      )}
    </div>
  );
}
