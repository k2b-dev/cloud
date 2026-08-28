import { crypto, i18n } from "@k2b/stdlib";
import { CopyButton, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

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

export default function HashGenerator() {
  const locale = useLocale();
  const t = () => hashMessages.resolve([locale()]).t;
  const [input, setInput] = createSignal("");
  const [sha256, setSha256] = createSignal("");
  const [fnv1a, setFnv1a] = createSignal("");
  createEffect(async () => {
    const text = input();
    if (!text) {
      setSha256("");
      setFnv1a("");
      return;
    }
    setSha256(await crypto.common.hash(text));
    setFnv1a(crypto.common.fnv1aHash(text));
  });

  const HashOutput = (props: { label: string; value: string; warning?: string }) => (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-dimmed">{props.label}</p>
        {props.warning && <span class="text-xs text-orange-500">{props.warning}</span>}
      </div>
      <div class="flex items-start gap-2">
        <ToolCodeBlock class="min-h-8 flex-1">{props.value || <span class="text-dimmed italic">—</span>}</ToolCodeBlock>
        {props.value && <CopyButton text={props.value} class="shrink-0" />}
      </div>
    </div>
  );

  return (
    <div class="flex flex-col gap-4">
      <div class="paper p-4">
        <TextInput
          label={t().inputLabel}
          description={t().inputDescription}
          placeholder={t().inputPlaceholder}
          multiline
          icon="ti ti-text-caption"
          value={input}
          onValueChange={setInput}
        />
      </div>

      <div class="paper p-4 flex flex-col gap-3">
        <HashOutput label="SHA-256" value={sha256()} />
        <HashOutput label="FNV-1a" value={fnv1a()} warning={t().notCryptographic} />
      </div>
    </div>
  );
}
