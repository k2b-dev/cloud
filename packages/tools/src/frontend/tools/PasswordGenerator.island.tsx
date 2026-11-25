import { i18n, password as pwdGen } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Check, Choice, Field, Input, Pane, Section } from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import ToolsScreen from "../ToolsScreen";
import { useToolCopy } from "../tool-copy";

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

const tone = (mode: PasswordMode, char: string): string | undefined => {
  if (mode === "pin" || /\d/.test(char)) return "var(--k2-blue)";
  if (mode === "memorable" && char === "-") return "var(--k2-bad)";
  if (/[^A-Za-z0-9]/.test(char)) return "var(--k2-warn-ink)";
  return undefined;
};

/** A whole number from a field, kept inside its range. */
const within = (value: string, min: number, max: number, fallback: number) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

/**
 * Passwords on v2: the kind as a choice with what it is good for, its settings as fields and switches, and the result
 * drawn large with digits and symbols in their own colour. Copy is the page's main deed; "Neu" draws another one.
 */
export default function PasswordGenerator() {
  const locale = useLocale();
  const t = () => passwordMessages.resolve([locale()]).t;
  const copy = useToolCopy();
  const [mode, setMode] = createSignal<PasswordMode>("random");
  const hint = () => (mode() === "memorable" ? t().memorableBody : mode() === "pin" ? t().pinBody : t().randomBody);
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
        return pwdGen.random({ length: randomLength(), uppercase: randomUppercase(), numbers: randomNumbers(), symbols: randomSymbols() });
    }
  });
  const refresh = () => setNonce((value) => value + 1);
  const copyAction = { label: t().copyPassword, icon: "copy", onClick: () => void copy(password()) };
  return (
    <ToolsScreen
      tool="password"
      primary={copyAction}
      end={
        <Button variant="primary" icon="copy" onClick={() => void copy(password())}>
          {t().copyPassword}
        </Button>
      }
    >
      <Pane label={t().generatedPassword} scrollKey="tools-password">
        <Section icon="key" title={t().generatedPassword} actions={[{ label: t().refreshPassword, icon: "refresh", onClick: refresh }]}>
          {/* The password is drawn: large, sign by sign, digits and symbols in their own colour, wrapped anywhere. */}
          <Canvas label={t().generatedPassword} height={120}>
            <div
              style={{
                display: "grid",
                "place-items": "center",
                height: "100%",
                padding: "0 20px",
                font: "600 28px/1.15 var(--k2-font-mono)",
                "text-align": "center",
                "overflow-wrap": "anywhere",
                "user-select": "all",
              }}
            >
              <span>
                <For each={password().split("")}>{(char) => <span style={{ color: tone(mode(), char) }}>{char}</span>}</For>
              </span>
            </div>
          </Canvas>
        </Section>
        <Band label={t().passwordType}>
          <Field label={t().passwordType} hint={hint()}>
            <Choice
              name="password-mode"
              value={mode()}
              onChange={(value) => setMode(value as PasswordMode)}
              options={[
                { value: "random", label: t().modeRandom },
                { value: "memorable", label: t().modeMemorable },
                { value: "pin", label: t().modePin },
              ]}
            />
          </Field>
          <Show when={mode() === "random"}>
            <Field label={t().characters} optional="8–64">
              <Input
                type="number"
                min={8}
                max={64}
                value={String(randomLength())}
                onInput={(value) => setRandomLength(within(value, 8, 64, 20))}
              />
            </Field>
            <Check switch label={t().uppercase} checked={randomUppercase()} onChange={setRandomUppercase} />
            <Check switch label={t().numbers} checked={randomNumbers()} onChange={setRandomNumbers} />
            <Check switch label={t().symbols} checked={randomSymbols()} onChange={setRandomSymbols} />
          </Show>
          <Show when={mode() === "memorable"}>
            <Field label={t().words} optional="3–8">
              <Input
                type="number"
                min={3}
                max={8}
                value={String(memorableWords())}
                onInput={(value) => setMemorableWords(within(value, 3, 8, 4))}
              />
            </Field>
            <Check switch label={t().capitalizeFirstLetter} checked={memorableCapitalize()} onChange={setMemorableCapitalize} />
            <Check switch label={t().useFullWords} checked={memorableFullWords()} onChange={setMemorableFullWords} />
            <Check switch label={t().addNumber} checked={memorableNumber()} onChange={setMemorableNumber} />
            <Check switch label={t().addSymbol} checked={memorableSymbol()} onChange={setMemorableSymbol} />
          </Show>
          <Show when={mode() === "pin"}>
            <Field label={t().digits} optional="4–12">
              <Input
                type="number"
                min={4}
                max={12}
                value={String(pinLength())}
                onInput={(value) => setPinLength(within(value, 4, 12, 6))}
              />
            </Field>
          </Show>
        </Band>
      </Pane>
    </ToolsScreen>
  );
}
