import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Button, Choice, Field, Input, Pane, Section, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onMount } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { useToolCopy } from "../tool-copy";
import { toolsWorkspaceMessages } from "../tools-messages";

type Mode = "paragraphs" | "sentences" | "words";

export const loremMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      paragraphs: "Paragraphs",
      sentences: "Sentences",
      words: "Words",
      count: "Count",
      countDescriptionParagraphs: "Number of paragraphs to generate",
      countDescriptionSentences: "Number of sentences to generate",
      countDescriptionWords: "Number of words to generate",
      regenerate: "Generate again",
      copied: "Copied",
      copyText: "Copy text",
    },
    de: {
      paragraphs: "Absätze",
      sentences: "Sätze",
      words: "Wörter",
      count: "Anzahl",
      countDescriptionParagraphs: "Absätze pro Durchlauf",
      countDescriptionSentences: "Sätze pro Durchlauf",
      countDescriptionWords: "Wörter pro Durchlauf",
      regenerate: "Neu erzeugen",
      copied: "Kopiert",
      copyText: "Text kopieren",
    },
  },
});

const WORDS = [
  "lorem",
  "ipsum",
  "dolor",
  "sit",
  "amet",
  "consectetur",
  "adipiscing",
  "elit",
  "sed",
  "do",
  "eiusmod",
  "tempor",
  "incididunt",
  "ut",
  "labore",
  "et",
  "dolore",
  "magna",
  "aliqua",
  "enim",
  "ad",
  "minim",
  "veniam",
  "quis",
  "nostrud",
  "exercitation",
  "ullamco",
  "laboris",
  "nisi",
  "aliquip",
  "ex",
  "ea",
  "commodo",
  "consequat",
  "duis",
  "aute",
  "irure",
  "in",
  "reprehenderit",
  "voluptate",
  "velit",
  "esse",
  "cillum",
  "fugiat",
  "nulla",
  "pariatur",
  "excepteur",
  "sint",
  "occaecat",
  "cupidatat",
  "non",
  "proident",
  "sunt",
  "culpa",
  "qui",
  "officia",
  "deserunt",
  "mollit",
  "anim",
  "id",
  "est",
  "laborum",
  "cras",
  "justo",
  "odio",
  "dapibus",
  "ac",
  "facilisis",
  "egestas",
  "maecenas",
  "faucibus",
  "porta",
  "lacus",
  "viverra",
  "accumsan",
  "pellentesque",
  "habitant",
  "morbi",
  "tristique",
  "senectus",
  "netus",
  "malesuada",
  "fames",
  "turpis",
  "integer",
  "feugiat",
  "scelerisque",
  "varius",
  "nunc",
  "mattis",
  "enim",
  "blandit",
  "volutpat",
  "pretium",
  "aenean",
  "pharetra",
  "vulputate",
  "leo",
  "vel",
  "augue",
  "cursus",
];

const randomWord = () => WORDS[Math.floor(Math.random() * WORDS.length)]!;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const generateSentence = (): string => {
  const len = 5 + Math.floor(Math.random() * 10);
  const words: string[] = [];
  for (let i = 0; i < len; i++) words.push(randomWord());
  words[0] = capitalize(words[0]!);
  return words.join(" ") + ".";
};

const generateParagraph = (): string => {
  const len = 3 + Math.floor(Math.random() * 5);
  const sentences: string[] = [];
  for (let i = 0; i < len; i++) sentences.push(generateSentence());
  return sentences.join(" ");
};

/**
 * Placeholder text on v2: the unit as a choice and the amount in a field; the text follows at once and reads as
 * paragraphs below. "Text kopieren" is the main deed, "Neu erzeugen" draws other words.
 */
export default function LoremIpsumGenerator() {
  const locale = useLocale();
  const t = () => loremMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const copy = useToolCopy();
  const [mode, setMode] = createSignal<Mode>("paragraphs");
  const [count, setCount] = createSignal(3);
  const [nonce, setNonce] = createSignal(0);
  // The words are random, so they come with the browser; the server's picture shows the empty result.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const maxCount = () => (mode() === "paragraphs" ? 20 : mode() === "sentences" ? 50 : 500);
  const paragraphs = createMemo(() => {
    nonce();
    if (!mounted()) return [];
    const amount = Math.min(count(), maxCount());
    if (mode() === "paragraphs") return Array.from({ length: amount }, generateParagraph);
    if (mode() === "sentences") return [Array.from({ length: amount }, generateSentence).join(" ")];
    const words = Array.from({ length: amount }, randomWord);
    words[0] = capitalize(words[0]!);
    return [`${words.join(" ")}.`];
  });
  const text = () => paragraphs().join("\n\n");
  const countDescription = () =>
    mode() === "paragraphs"
      ? t().countDescriptionParagraphs
      : mode() === "sentences"
        ? t().countDescriptionSentences
        : t().countDescriptionWords;
  const copyAction = { label: t().copyText, icon: "copy", onClick: () => void copy(text()) };
  return (
    <ToolsScreen
      tool="lorem"
      primary={copyAction}
      end={
        <>
          <Button icon="refresh" onClick={() => setNonce((value) => value + 1)}>
            {t().regenerate}
          </Button>
          <Button variant="primary" icon="copy" onClick={copyAction.onClick}>
            {t().copyText}
          </Button>
        </>
      }
    >
      <Pane label={w().result} scrollKey="tools-lorem">
        <Band label={w().settings}>
          <Field label={w().kind}>
            <Choice
              name="lorem-mode"
              value={mode()}
              onChange={(value) => setMode(value as Mode)}
              options={[
                { value: "paragraphs", label: t().paragraphs },
                { value: "sentences", label: t().sentences },
                { value: "words", label: t().words },
              ]}
            />
          </Field>
          <Field label={t().count} hint={countDescription()} optional={`1–${maxCount()}`}>
            <Input
              type="number"
              min={1}
              max={maxCount()}
              value={String(count())}
              onInput={(value) => {
                const next = Number.parseInt(value, 10);
                if (Number.isFinite(next)) setCount(Math.min(maxCount(), Math.max(1, next)));
              }}
            />
          </Field>
        </Band>
        <Section icon="align-left" title={w().result}>
          <For each={paragraphs()}>{(paragraph) => <Text type="body">{paragraph}</Text>}</For>
        </Section>
      </Pane>
    </ToolsScreen>
  );
}
