import { crypto, i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Facts, Field, Input, Section } from "@k2b/ui/v2";
import { createEffect, createSignal } from "solid-js";
import ToolsScreen, { ToolPane } from "../ToolsScreen";
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
      <ToolPane
        lead="input"
        scrollKey="tools-hash"
        label={w().result}
        input={
          <Section icon="cursor-text" title={w().input} measure>
            <Field label={t().inputLabel} hint={t().inputDescription}>
              <Input multiline placeholder={t().inputPlaceholder} value={input()} onInput={setInput} />
            </Field>
          </Section>
        }
        result={
          <Section icon="hash" title={w().result} summary={input() ? undefined : w().nothingYet}>
            {/* before any text, one quiet line where the result will stand */}
            <Facts
              items={[
                { label: "SHA-256", value: input() ? sha256() || "…" : "–", mono: true, copy: (input() && sha256()) || undefined },
                {
                  label: "FNV-1a",
                  value: input() ? fnv1a() : "–",
                  hint: t().notCryptographic,
                  mono: true,
                  copy: input() ? fnv1a() : undefined,
                },
              ]}
            />
          </Section>
        }
      />
    </ToolsScreen>
  );
}
