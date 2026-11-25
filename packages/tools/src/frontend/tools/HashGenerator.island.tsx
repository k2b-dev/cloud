import { crypto, i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Empty, Facts, Field, Input, Pane, Section } from "@k2b/ui/v2";
import { createEffect, createSignal, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolsWorkspaceMessages } from "../tools-messages";

export const hashMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      inputLabel: "Input",
      inputDescription: "The text will be hashed in real-time as you type",
      inputPlaceholder: "Text to hash...",
      notCryptographic: "Not cryptographic",
    },
    de: {
      inputLabel: "Eingabe",
      inputDescription: "Der Hash wird während der Eingabe aktualisiert",
      inputPlaceholder: "Text zum Hashen...",
      notCryptographic: "Nicht kryptografisch",
    },
  },
});

/** Checksums on v2: the text in one field, both sums below as values to copy; FNV-1a says it is not cryptographic. */
export default function HashGenerator() {
  const locale = useLocale();
  const t = () => hashMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const [input, setInput] = createSignal("");
  const [sha256, setSha256] = createSignal("");
  const fnv1a = () => (input() ? crypto.common.fnv1aHash(input()) : "");
  createEffect(() => {
    const text = input();
    if (!text) return setSha256("");
    void crypto.common.hash(text).then((sum) => {
      // only the sum of the text that is still there
      if (input() === text) setSha256(sum);
    });
  });
  return (
    <ToolsScreen tool="hash">
      <Pane label={w().result} scrollKey="tools-hash">
        <Band label={w().input}>
          <Field label={t().inputLabel} hint={t().inputDescription}>
            <Input multiline placeholder={t().inputPlaceholder} value={input()} onInput={setInput} />
          </Field>
        </Band>
        <Section icon="hash" title={w().result}>
          <Show when={input()} fallback={<Empty icon="hash" text={w().nothingYet} />}>
            <Facts
              items={[
                { label: "SHA-256", value: sha256() || "…", mono: true, copy: sha256() || undefined },
                { label: "FNV-1a", value: fnv1a(), hint: t().notCryptographic, mono: true, copy: fnv1a() },
              ]}
            />
          </Show>
        </Section>
      </Pane>
    </ToolsScreen>
  );
}
