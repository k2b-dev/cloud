import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Button, Field, Input, List, Pane, Row, StatusRow } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onMount } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { useToolCopy } from "../tool-copy";
import { toolsWorkspaceMessages } from "../tools-messages";

export const uuidMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      count: "Count",
      countDescription: "Number of UUIDs to generate at once",
      uuidCount: ({ count }: { count: number }) => (count === 1 ? "1 UUID" : `${count} UUIDs`),
      copied: "Copied",
      copyAll: "Copy all",
      regenerate: "Generate again",
    },
    de: {
      count: "Anzahl",
      countDescription: "UUIDs pro Durchlauf",
      uuidCount: ({ count }) => (count === 1 ? "1 UUID" : `${count} UUIDs`),
      copied: "Kopiert",
      copyAll: "Alle kopieren",
      regenerate: "Neu erzeugen",
    },
  },
});

/**
 * UUIDs on v2: how many in one field, the list of fresh ones below, each with its own copy; "Alle kopieren" is the
 * page's main deed, "Neu erzeugen" draws a new list.
 */
export default function UuidGenerator() {
  const locale = useLocale();
  const t = () => uuidMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const copy = useToolCopy();
  const [count, setCount] = createSignal(1);
  const [nonce, setNonce] = createSignal(0);
  // Server and first browser picture show the same empty list; the UUIDs come with the browser (they are random).
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const uuids = createMemo(() => {
    nonce();
    if (!mounted()) return [];
    return Array.from({ length: count() }, () => crypto.randomUUID());
  });
  const copyAll = { label: t().copyAll, icon: "copy", onClick: () => void copy(uuids().join("\n")) };
  return (
    <ToolsScreen
      tool="uuid"
      primary={copyAll}
      end={
        <>
          <Button icon="refresh" onClick={() => setNonce((value) => value + 1)}>
            {t().regenerate}
          </Button>
          <Button variant="primary" icon="copy" onClick={copyAll.onClick}>
            {t().copyAll}
          </Button>
        </>
      }
    >
      <Pane label={w().result} scrollKey="tools-uuid" status={<StatusRow lead={t().uuidCount({ count: uuids().length })} />}>
        <Band label={w().settings}>
          <Field label={t().count} hint={t().countDescription} optional="1–100">
            <Input
              type="number"
              min={1}
              max={100}
              value={String(count())}
              onInput={(value) => {
                const next = Number.parseInt(value, 10);
                if (Number.isFinite(next)) setCount(Math.min(100, Math.max(1, next)));
              }}
            />
          </Field>
        </Band>
        <List label={w().result}>
          <For each={uuids()}>
            {(uuid) => <Row lines={[uuid]} end={<Button variant="ghost" icon="copy" label={w().copy} onClick={() => void copy(uuid)} />} />}
          </For>
        </List>
      </Pane>
    </ToolsScreen>
  );
}
