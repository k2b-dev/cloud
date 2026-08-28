import { i18n, password as pwdGen } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import { Button, NoticeCard, SegmentedControl, Slider, Switch, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX } from "solid-js";

type PasswordMode = "random" | "memorable" | "pin";

export const passwordMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      passwordType: "Password type",
      modeRandom: "Random",
      modeMemorable: "Memorable",
      modePin: "PIN",
      randomTitle: "Random passwords",
      randomBody:
        "Use a longer random password for the strongest general-purpose protection. Add numbers and symbols when the password should be stronger and harder to guess.",
      memorableTitle: "Memorable passwords",
      memorableBody:
        "Readable word-based passwords are easier to type and remember. You can still add a random number or symbol when password rules require extra variation.",
      pinTitle: "PIN passwords",
      pinBody: "Use a short numeric PIN when a device or lock screen only allows digits.",
      characters: "Characters",
      uppercase: "Uppercase",
      numbers: "Numbers",
      symbols: "Symbols",
      words: "Words",
      capitalizeFirstLetter: "Capitalize first letter",
      useFullWords: "Use full words",
      addNumber: "Add number",
      addSymbol: "Add symbol",
      digits: "Digits",
      generatedPassword: "Generated password",
      copied: "Copied",
      copyPassword: "Copy password",
      refreshPassword: "Refresh password",
    },
    de: {
      passwordType: "Passworttyp",
      modeRandom: "Zufällig",
      modeMemorable: "Merkbar",
      modePin: "PIN",
      randomTitle: "Zufällige Passwörter",
      randomBody:
        "Ein langes zufälliges Passwort eignet sich für die meisten Anmeldungen. Aktiviere Zahlen und Symbole, wenn die Passwortregeln sie verlangen.",
      memorableTitle: "Merkbare Passwörter",
      memorableBody:
        "Passwörter aus Wörtern lassen sich leichter eingeben und merken. Ergänze eine zufällige Zahl oder ein Symbol, wenn die Passwortregeln es verlangen.",
      pinTitle: "PIN-Passwörter",
      pinBody: "Verwende eine kurze numerische PIN nur, wenn ein Gerät oder Sperrbildschirm ausschließlich Ziffern zulässt.",
      characters: "Zeichen",
      uppercase: "Großbuchstaben",
      numbers: "Zahlen",
      symbols: "Symbole",
      words: "Wörter",
      capitalizeFirstLetter: "Ersten Buchstaben großschreiben",
      useFullWords: "Ganze Wörter verwenden",
      addNumber: "Zahl hinzufügen",
      addSymbol: "Symbol hinzufügen",
      digits: "Ziffern",
      generatedPassword: "Erstelltes Passwort",
      copied: "Kopiert",
      copyPassword: "Passwort kopieren",
      refreshPassword: "Passwort neu generieren",
    },
  },
});

const randomCharTone = (char: string): string => {
  if (/\d/.test(char)) return "text-blue-600 dark:text-blue-300";
  if (/[^A-Za-z0-9]/.test(char)) return "text-amber-600 dark:text-amber-300";
  return "text-primary";
};

const memorableCharTone = (char: string): string => {
  if (/\d/.test(char)) return "text-blue-600 dark:text-blue-300";
  if (char === "-") return "text-red-500 dark:text-red-300";
  if (/[^A-Za-z0-9]/.test(char)) return "text-amber-600 dark:text-amber-300";
  return "text-primary";
};

const pinCharTone = (): string => "text-blue-600 dark:text-blue-300";

const RangeField = (props: {
  label: string;
  value: () => number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) => (
  <Slider
    label={props.label}
    value={props.value}
    onValueChange={props.onChange}
    min={props.min}
    max={props.max}
    step={props.step ?? 1}
    showValue
  />
);

const ToggleRow = (props: { children: JSX.Element; columns?: string }) => (
  <div class={`grid gap-4 ${props.columns ?? "sm:grid-cols-2"}`}>{props.children}</div>
);

const InlineToggle = (props: { label: string; value: () => boolean; onChange: (value: boolean) => void }) => (
  <div class="flex items-center gap-3">
    <span class="text-sm text-secondary">{props.label}</span>
    <Switch value={props.value} onValueChange={props.onChange} />
  </div>
);

const OutputPreview = (props: { mode: () => PasswordMode; value: () => string }) => {
  const chars = () => props.value().split("");
  const tone = (char: string) => {
    if (props.mode() === "pin") return pinCharTone();
    if (props.mode() === "memorable") return memorableCharTone(char);
    return randomCharTone(char);
  };

  return (
    <div class="grid min-h-32 place-items-center py-1">
      <div class="grid min-h-[7rem] w-full place-items-center">
        <div class="w-full text-center font-mono text-2xl font-semibold leading-[1.15] tracking-[0.02em] whitespace-normal break-all [overflow-wrap:anywhere] sm:text-3xl">
          <For each={chars()}>{(char) => <span class={tone(char)}>{char}</span>}</For>
        </div>
      </div>
    </div>
  );
};

export default function PasswordGenerator() {
  const locale = useLocale();
  const t = () => passwordMessages.resolve([locale()]).t;
  const [mode, setMode] = createSignal<PasswordMode>("random");

  const modeInfo = (): { title: string; body: string } => {
    const messages = t();
    switch (mode()) {
      case "memorable":
        return { title: messages.memorableTitle, body: messages.memorableBody };
      case "pin":
        return { title: messages.pinTitle, body: messages.pinBody };
      default:
        return { title: messages.randomTitle, body: messages.randomBody };
    }
  };
  const [randomLength, setRandomLength] = createSignal(20);
  const [randomUppercase, setRandomUppercase] = createSignal(true);
  const [randomNumbers, setRandomNumbers] = createSignal(true);
  const [randomSymbols, setRandomSymbols] = createSignal(false);
  const [memorableWords, setMemorableWords] = createSignal(4);
  const [memorableCapitalize, setMemorableCapitalize] = createSignal(false);
  const [memorableFullWords, setMemorableFullWords] = createSignal(true);
  const [memorableNumber, setMemorableNumber] = createSignal(false);
  const [memorableSymbol, setMemorableSymbol] = createSignal(false);
  const [pinLength, setPinLength] = createSignal(6);
  const [nonce, setNonce] = createSignal(0);
  const [copied, setCopied] = createSignal(false);

  const password = createMemo(() => {
    nonce();
    switch (mode()) {
      case "memorable":
        return pwdGen.memorable({
          words: memorableWords(),
          capitalize: memorableCapitalize(),
          fullWords: memorableFullWords(),
          addNumber: memorableNumber(),
          addSymbol: memorableSymbol(),
        });
      case "pin":
        return pwdGen.pin({ length: pinLength() });
      default:
        return pwdGen.random({
          length: randomLength(),
          uppercase: randomUppercase(),
          numbers: randomNumbers(),
          symbols: randomSymbols(),
        });
    }
  });

  createEffect(() => {
    password();
    setCopied(false);
  });

  const refresh = () => setNonce((value) => value + 1);

  const setRandomCharset = (key: "uppercase" | "numbers" | "symbols", enabled: boolean) => {
    if (key === "uppercase") setRandomUppercase(enabled);
    if (key === "numbers") setRandomNumbers(enabled);
    if (key === "symbols") setRandomSymbols(enabled);
  };

  const copyPassword = async () => {
    await clipboard.copy(password());
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div class="flex flex-col gap-5">
      <SegmentedControl
        value={mode}
        onValueChange={setMode}
        ariaLabel={t().passwordType}
        options={[
          { value: "random", label: t().modeRandom, icon: "ti ti-arrows-shuffle" },
          { value: "memorable", label: t().modeMemorable, icon: "ti ti-bulb" },
          { value: "pin", label: t().modePin, icon: "ti ti-hash" },
        ]}
      />

      <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
        <i class="ti ti-info-circle shrink-0 mt-0.5" />
        <div class="text-sm">
          <strong>{modeInfo().title}</strong> {modeInfo().body}
        </div>
      </NoticeCard>

      <section class="paper p-4">
        <div class="flex flex-col gap-5">
          {mode() === "random" && (
            <>
              <RangeField label={t().characters} value={randomLength} onChange={setRandomLength} min={8} max={64} />
              <ToggleRow columns="sm:grid-cols-2 xl:grid-cols-3">
                <InlineToggle label={t().uppercase} value={randomUppercase} onChange={(value) => setRandomCharset("uppercase", value)} />
                <InlineToggle label={t().numbers} value={randomNumbers} onChange={(value) => setRandomCharset("numbers", value)} />
                <InlineToggle label={t().symbols} value={randomSymbols} onChange={(value) => setRandomCharset("symbols", value)} />
              </ToggleRow>
            </>
          )}

          {mode() === "memorable" && (
            <>
              <RangeField label={t().words} value={memorableWords} onChange={setMemorableWords} min={3} max={8} />
              <ToggleRow columns="sm:grid-cols-2 xl:grid-cols-4">
                <InlineToggle label={t().capitalizeFirstLetter} value={memorableCapitalize} onChange={setMemorableCapitalize} />
                <InlineToggle label={t().useFullWords} value={memorableFullWords} onChange={setMemorableFullWords} />
                <InlineToggle label={t().addNumber} value={memorableNumber} onChange={setMemorableNumber} />
                <InlineToggle label={t().addSymbol} value={memorableSymbol} onChange={setMemorableSymbol} />
              </ToggleRow>
            </>
          )}

          {mode() === "pin" && <RangeField label={t().digits} value={pinLength} onChange={setPinLength} min={4} max={12} />}
        </div>
      </section>

      <section class="flex flex-col gap-3">
        <div>
          <h2 class="text-base font-semibold text-primary">{t().generatedPassword}</h2>
        </div>
        <div class="paper p-4">
          <OutputPreview mode={mode} value={password} />
        </div>
      </section>

      <div class="grid gap-3 sm:grid-cols-2">
        <Button class="justify-center" onClick={copyPassword}>
          <i class={`ti ${copied() ? "ti-check" : "ti-copy"}`} />
          {copied() ? t().copied : t().copyPassword}
        </Button>
        <Button variant="secondary" class="justify-center" onClick={refresh}>
          <i class="ti ti-refresh" />
          {t().refreshPassword}
        </Button>
      </div>
    </div>
  );
}
