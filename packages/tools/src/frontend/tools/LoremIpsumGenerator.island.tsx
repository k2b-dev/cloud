import { i18n } from "@k2b/stdlib";
import { timed } from "@k2b/stdlib/solid";
import { Button, SegmentedControl, Slider, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal } from "solid-js";
import { ToolCodeBlock } from "./ToolOutput";

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
      regenerate: "Regenerate",
      copied: "Copied",
      copyText: "Copy Text",
    },
    de: {
      paragraphs: "Absätze",
      sentences: "Sätze",
      words: "Wörter",
      count: "Anzahl",
      countDescriptionParagraphs: "Absätze pro Durchlauf",
      countDescriptionSentences: "Sätze pro Durchlauf",
      countDescriptionWords: "Wörter pro Durchlauf",
      regenerate: "Neu generieren",
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

export default function LoremIpsumGenerator() {
  const locale = useLocale();
  const t = () => loremMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal<Mode>("paragraphs");
  const [count, setCount] = createSignal(3);
  const [output, setOutput] = createSignal("");
  const [copied, setCopied] = createSignal(false);

  const maxCount = createMemo(() => {
    switch (mode()) {
      case "paragraphs":
        return 20;
      case "sentences":
        return 50;
      case "words":
        return 500;
    }
  });

  const generate = () => {
    switch (mode()) {
      case "paragraphs": {
        const paras: string[] = [];
        for (let i = 0; i < count(); i++) paras.push(generateParagraph());
        setOutput(paras.join("\n\n"));
        break;
      }
      case "sentences": {
        const sents: string[] = [];
        for (let i = 0; i < count(); i++) sents.push(generateSentence());
        setOutput(sents.join(" "));
        break;
      }
      case "words": {
        const words: string[] = [];
        for (let i = 0; i < count(); i++) words.push(randomWord());
        words[0] = capitalize(words[0]!);
        setOutput(words.join(" ") + ".");
        break;
      }
    }
  };

  const { debouncedFn: debouncedGenerate, trigger: generateNow } = timed.debounce(generate, 200);

  // Live regenerate when mode or count changes (initial mount included).
  createEffect(() => {
    mode();
    count();
    debouncedGenerate();
  });

  const copy = async () => {
    await navigator.clipboard.writeText(output());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const countDescription = () => {
    switch (mode()) {
      case "paragraphs":
        return t().countDescriptionParagraphs;
      case "sentences":
        return t().countDescriptionSentences;
      case "words":
        return t().countDescriptionWords;
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <SegmentedControl
        options={[
          { value: "paragraphs" as Mode, label: t().paragraphs },
          { value: "sentences" as Mode, label: t().sentences },
          { value: "words" as Mode, label: t().words },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      <div class="paper p-4 flex flex-col gap-3">
        <Slider
          label={t().count}
          description={countDescription()}
          value={count}
          onValueChange={setCount}
          min={1}
          max={maxCount()}
          step={1}
          showValue
        />
        <Button size="sm" class="self-start" onClick={() => generateNow()}>
          <i class="ti ti-refresh" /> {t().regenerate}
        </Button>
      </div>
      {output() && (
        <div class="paper p-4 flex flex-col gap-3">
          <ToolCodeBlock class="max-h-96 overflow-y-auto text-sm leading-relaxed">{output()}</ToolCodeBlock>
          <Button size="sm" class="self-start" onClick={copy}>
            <i class={`ti ${copied() ? "ti-check" : "ti-copy"}`} /> {copied() ? t().copied : t().copyText}
          </Button>
        </div>
      )}
    </div>
  );
}
