import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Button, Facts, Field, Section, Slider } from "@k2b/ui/v2";
import { createMemo, createSignal, onMount } from "solid-js";
import ToolsScreen, { ToolPanes } from "../ToolsScreen";
import { useToolCopy } from "../tool-copy";
import { toolsWorkspaceMessages } from "../tools-messages";

export const uuidMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      count: "Count",
      countDescription: "Number of UUIDs to generate at once",
      copied: "Copied",
      copyAll: "Copy all",
      regenerate: "Generate again",
    },
    de: {
      count: "Anzahl",
      countDescription: "UUIDs pro Durchlauf",
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
      <ToolPanes
        kind="generator"
        scrollKey="tools-uuid"
        result={{
          label: w().result,
          children: (
            // technical values in monospace, each with its copy; the count is a quiet number at the head
            <Section title={w().result} count={uuids().length || undefined}>
              <Facts items={uuids().map((uuid, index) => ({ label: String(index + 1), value: uuid, mono: true, copy: uuid }))} />
            </Section>
          ),
        }}
        input={{
          label: w().settings,
          children: (
            <Band label={w().settings}>
              <Field label={t().count} hint={t().countDescription} optional="1–100">
                <Slider min={1} max={100} value={count()} onChange={setCount} />
              </Field>
            </Band>
          ),
        }}
      />
    </ToolsScreen>
  );
}
