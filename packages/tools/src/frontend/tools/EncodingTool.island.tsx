import { encoding, i18n } from "@k2b/stdlib";
import { Button, SegmentedControl, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

type Direction = "encode" | "decode";
type Format = "base64" | "hex" | "base32";

const FORMAT_NAMES: Record<Format, string> = { base64: "Base64", hex: "Hex", base32: "Base32" };

export const encodingMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      encode: "Encode",
      decode: "Decode",
      inputTextLabel: "Input Text",
      formatInputLabel: ({ format }: { format: string }) => `${format} Input`,
      encodeDescription: "Plain text that will be converted to the selected format.",
      decodeDescription: ({ format }: { format: string }) => `Paste ${format} encoded data to decode back to plain text.`,
      encodePlaceholder: "Text to encode...",
      decodePlaceholder: "Encoded data to decode...",
      formatOutputLabel: ({ format }: { format: string }) => `${format} Output`,
      decodedText: "Decoded Text",
      invalidInput: "Invalid input",
      copied: "Copied",
      copy: "Copy",
    },
    de: {
      encode: "Kodieren",
      decode: "Dekodieren",
      inputTextLabel: "Eingabetext",
      formatInputLabel: ({ format }) => `${format}-Eingabe`,
      encodeDescription: "Klartext, der in das gewählte Format umgewandelt wird.",
      decodeDescription: ({ format }) => `Füge ${format}-kodierte Daten ein, um sie wieder in Klartext umzuwandeln.`,
      encodePlaceholder: "Text zum Kodieren...",
      decodePlaceholder: "Kodierte Daten zum Dekodieren...",
      formatOutputLabel: ({ format }) => `${format}-Ausgabe`,
      decodedText: "Dekodierter Text",
      invalidInput: "Ungültige Eingabe",
      copied: "Kopiert",
      copy: "Kopieren",
    },
  },
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
};

export default function EncodingTool() {
  const locale = useLocale();
  const t = () => encodingMessages.resolve([locale()]).t;
  const [direction, setDirection] = createSignal<Direction>("encode");
  const [format, setFormat] = createSignal<Format>("base64");
  const [input, setInput] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();

  const output = createMemo(() => {
    const text = input();
    if (!text) {
      setError(undefined);
      return "";
    }

    try {
      setError(undefined);
      if (direction() === "encode") {
        const bytes = encoder.encode(text);
        switch (format()) {
          case "base64":
            return encoding.toBase64(bytes);
          case "hex":
            return encoding.toHex(bytes);
          case "base32":
            return encoding.toBase32(bytes);
        }
      } else {
        let bytes: Uint8Array;
        switch (format()) {
          case "base64":
            bytes = encoding.fromBase64(text);
            break;
          case "hex":
            bytes = encoding.fromHex(text);
            break;
          case "base32":
            bytes = encoding.fromBase32(text);
            break;
        }
        return decoder.decode(bytes);
      }
    } catch (error) {
      setError(getErrorMessage(error, t().invalidInput));
      return "";
    }
  });

  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    const val = output();
    if (!val) return;
    await navigator.clipboard.writeText(val);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="paper p-4 flex flex-col gap-3">
        {/* Direction */}
        <SegmentedControl
          options={[
            {
              value: "encode" as Direction,
              label: t().encode,
              icon: "ti ti-arrow-right",
            },
            {
              value: "decode" as Direction,
              label: t().decode,
              icon: "ti ti-arrow-left",
            },
          ]}
          value={direction}
          onValueChange={setDirection}
        />

        {/* Format */}
        <SegmentedControl
          options={[
            { value: "base64" as Format, label: "Base64" },
            { value: "hex" as Format, label: "Hex" },
            { value: "base32" as Format, label: "Base32" },
          ]}
          value={format}
          onValueChange={setFormat}
        />

        <TextInput
          label={direction() === "encode" ? t().inputTextLabel : t().formatInputLabel({ format: FORMAT_NAMES[format()] })}
          description={
            direction() === "encode" ? t().encodeDescription : t().decodeDescription({ format: FORMAT_NAMES[format()] })
          }
          placeholder={direction() === "encode" ? t().encodePlaceholder : t().decodePlaceholder}
          multiline
          value={input}
          onValueChange={setInput}
          error={error}
        />
      </div>

      {output() && (
        <div class="paper p-4 flex flex-col gap-3">
          <p class="text-xs font-medium text-dimmed">
            {direction() === "encode" ? t().formatOutputLabel({ format: FORMAT_NAMES[format()] }) : t().decodedText}
          </p>
          <ToolCodeBlock>{output()}</ToolCodeBlock>
          <Button size="sm" class="self-start" onClick={copy}>
            <i class={`ti ${copied() ? "ti-check" : "ti-copy"}`} />
            {copied() ? t().copied : t().copy}
          </Button>
        </div>
      )}
    </div>
  );
}
