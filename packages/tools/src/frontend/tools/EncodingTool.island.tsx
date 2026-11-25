import { encoding, i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Choice, Empty, Facts, Field, Input, Pane, Section } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { toolsWorkspaceMessages } from "../tools-messages";

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

/**
 * Encoding on v2: the direction and the format as choices, the text in one field (an error stands at it), the result
 * below as a value to copy.
 */
export default function EncodingTool() {
  const locale = useLocale();
  const t = () => encodingMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const [direction, setDirection] = createSignal<Direction>("encode");
  const [format, setFormat] = createSignal<Format>("base64");
  const [input, setInput] = createSignal("");
  const result = createMemo((): { output: string; error?: string } => {
    const text = input();
    if (!text) return { output: "" };
    try {
      if (direction() === "encode") {
        const bytes = encoder.encode(text);
        return {
          output: format() === "base64" ? encoding.toBase64(bytes) : format() === "hex" ? encoding.toHex(bytes) : encoding.toBase32(bytes),
        };
      }
      const bytes =
        format() === "base64" ? encoding.fromBase64(text) : format() === "hex" ? encoding.fromHex(text) : encoding.fromBase32(text);
      return { output: decoder.decode(bytes) };
    } catch (error) {
      return { output: "", error: getErrorMessage(error, t().invalidInput) };
    }
  });
  const outputLabel = () => (direction() === "encode" ? t().formatOutputLabel({ format: FORMAT_NAMES[format()] }) : t().decodedText);
  return (
    <ToolsScreen tool="encoding">
      <Pane label={w().result} scrollKey="tools-encoding">
        <Band label={w().settings}>
          <Field.Row>
            <Field label={w().direction}>
              <Choice
                name="encoding-direction"
                value={direction()}
                onChange={(value) => setDirection(value as Direction)}
                options={[
                  { value: "encode", label: t().encode },
                  { value: "decode", label: t().decode },
                ]}
              />
            </Field>
            <Field label={w().format}>
              <Choice
                name="encoding-format"
                value={format()}
                onChange={(value) => setFormat(value as Format)}
                options={[
                  { value: "base64", label: "Base64" },
                  { value: "hex", label: "Hex" },
                  { value: "base32", label: "Base32" },
                ]}
              />
            </Field>
          </Field.Row>
          <Field
            label={direction() === "encode" ? t().inputTextLabel : t().formatInputLabel({ format: FORMAT_NAMES[format()] })}
            hint={direction() === "encode" ? t().encodeDescription : t().decodeDescription({ format: FORMAT_NAMES[format()] })}
            error={result().error}
          >
            <Input
              multiline
              placeholder={direction() === "encode" ? t().encodePlaceholder : t().decodePlaceholder}
              value={input()}
              onInput={setInput}
            />
          </Field>
        </Band>
        <Section icon="transform" title={w().result}>
          <Show when={result().output} fallback={<Empty icon="transform" text={w().nothingYet} />}>
            <Facts items={[{ label: outputLabel(), value: result().output, mono: true, copy: result().output }]} />
          </Show>
        </Section>
      </Pane>
    </ToolsScreen>
  );
}
