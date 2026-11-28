import { i18n, password as pwdGen } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Canvas, Check, Chip, Choice, Facts, Field, Inline, Progress, Section, Slider } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import ToolsScreen, { ToolPane } from "../ToolsScreen";
import { useToolCopy } from "../tool-copy";
import { toolsWorkspaceMessages } from "../tools-messages";

type PasswordMode = "random" | "memorable" | "pin";

export const passwordMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      passwordType: "Password type",
      modeRandom: "Random",
      modeMemorable: "Memorable",
      modePin: "PIN",
      randomBody:
        "Use a longer random password for the strongest general-purpose protection. Add numbers and symbols when the password should be stronger and harder to guess.",
      memorableBody:
        "Readable word-based passwords are easier to type and remember. You can still add a random number or symbol when password rules require extra variation.",
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
      strength: "Strength",
      lengthChip: ({ count }: { count: number }) => `${count} characters`,
      wordsChip: ({ count }: { count: number }) => `${count} words`,
      digitsChip: ({ count }: { count: number }) => `${count} digits`,
      lowercase: "Lowercase",
      recent: "Generated before",
      recentHint: "Only in this tab; nothing is stored.",
      strengthLabel: ({ word, bits }: { word: string; bits: number }) => `${word} · ${bits} bit`,
      strengthWord: ({ score }: { score: number }) => ["very weak", "weak", "fair", "strong", "very strong"][score] ?? "",
    },
    de: {
      passwordType: "Passworttyp",
      modeRandom: "Zufällig",
      modeMemorable: "Merkbar",
      modePin: "PIN",
      randomBody:
        "Ein langes zufälliges Passwort eignet sich für die meisten Anmeldungen. Aktiviere Zahlen und Symbole, wenn die Passwortregeln sie verlangen.",
      memorableBody:
        "Passwörter aus Wörtern lassen sich leichter eingeben und merken. Ergänze eine zufällige Zahl oder ein Symbol, wenn die Passwortregeln es verlangen.",
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
      strength: "Stärke",
      lengthChip: ({ count }) => `${count} Zeichen`,
      wordsChip: ({ count }) => `${count} Wörter`,
      digitsChip: ({ count }) => `${count} Ziffern`,
      lowercase: "Kleinbuchstaben",
      recent: "Zuvor erzeugt",
      recentHint: "Nur in diesem Tab, nichts wird gespeichert.",
      strengthLabel: ({ word, bits }) => `${word} · ${bits} Bit`,
      strengthWord: ({ score }) => ["sehr schwach", "schwach", "mittel", "stark", "sehr stark"][score] ?? "",
    },
  },
});

const tone = (mode: PasswordMode, char: string): string | undefined => {
  if (mode === "pin" || /\d/.test(char)) return "var(--k2-blue)";
  if (mode === "memorable" && char === "-") return "var(--k2-bad)";
  if (/[^A-Za-z0-9]/.test(char)) return "var(--k2-warn-ink)";
  return undefined;
};

/**
 * Passwords on v2: the kind as a choice with what it is good for, its settings as fields and switches, and the result
 * drawn large with digits and symbols in their own colour. Copy is the page's main deed; "Neu" draws another one.
 */
export default function PasswordGenerator() {
  const locale = useLocale();
  const t = () => passwordMessages.resolve([locale()]).t;
  const w = () => toolsWorkspaceMessages.resolve([locale()]).t;
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
  // made in the browser only: a password made while the server renders would differ from the one the island makes, and
  // a secret has no business in the page's markup. Until then the drawing keeps its place empty.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  const password = createMemo(() => {
    nonce();
    if (!mounted()) return "";
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
  const strength = createMemo(() => pwdGen.strength(password()));
  // What the password holds, from its settings, not from the password itself: the server renders the same chips the
  // island shows after it made the password, so nothing moves on mount. (stdlib puts each chosen kind in.)
  const contents = createMemo(() => {
    const kinds = (list: (string | false)[]) => list.filter((kind): kind is string => kind !== false);
    switch (mode()) {
      case "memorable":
        return [
          t().wordsChip({ count: memorableWords() }),
          ...kinds([
            memorableCapitalize() && t().uppercase,
            t().lowercase,
            memorableNumber() && t().digits,
            memorableSymbol() && t().symbols,
          ]),
        ];
      case "pin":
        return [t().digitsChip({ count: pinLength() })];
      default:
        return [
          t().lengthChip({ count: randomLength() }),
          ...kinds([randomUppercase() && t().uppercase, t().lowercase, randomNumbers() && t().digits, randomSymbols() && t().symbols]),
        ];
    }
  });
  // The passwords left behind, in this tab's memory only (never stored, gone on reload). One enters when it is left
  // with "Neu" or copied, never on a step of a setting: six presses on the length are no six passwords anyone chose.
  const [recent, setRecent] = createSignal<{ value: string; time: string }[]>([]);
  const remember = (value: string) => {
    if (!value || recent()[0]?.value === value) return;
    const time = new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
    setRecent((list) => [{ value, time }, ...list.filter((entry) => entry.value !== value)].slice(0, 5));
  };
  const refresh = () => {
    remember(password());
    setNonce((value) => value + 1);
  };
  const copyPassword = () => {
    remember(password());
    void copy(password());
  };
  const copyAction = { label: t().copyPassword, icon: "copy", onClick: copyPassword };
  return (
    <ToolsScreen
      tool="password"
      primary={copyAction}
      end={
        <Button variant="primary" icon="copy" floats onClick={copyPassword}>
          {t().copyPassword}
        </Button>
      }
    >
      <ToolPane
        lead="result"
        scrollKey="tools-password"
        label={t().generatedPassword}
        result={
          <>
            <Section title={t().generatedPassword} actions={[{ label: t().refreshPassword, icon: "refresh", onClick: refresh }]}>
              {/* The password is drawn: large, sign by sign, digits and symbols in their own colour, wrapped anywhere. */}
              <Canvas label={t().generatedPassword} height={120}>
                <div
                  style={{
                    display: "grid",
                    "place-items": "center",
                    height: "100%",
                    padding: "0 20px",
                    "container-type": "inline-size",
                    "overflow-y": "auto",
                    "text-align": "center",
                    "overflow-wrap": "anywhere",
                    // the lines share the signs evenly, so no single sign stands alone on the last line
                    "text-wrap": "balance",
                    "user-select": "all",
                  }}
                >
                  {/* three steps by length keep the 120 px drawing whole, the short ones as the figure of the page (30). No
                        step is wider than the drawing (100cqw) allows for one line of signs at 0.8 em each: room for a
                        fallback face whose M and W are wider than a mono sign (seen on the test VM), so 20 signs stay on
                        one line on a phone instead of leaving signs alone; anything longer scrolls inside */}
                  <span
                    style={{
                      "font-family": "var(--k2-font-mono)",
                      "font-weight": 600,
                      "line-height": 1.3,
                      "font-size": `min(${password().length <= 20 ? 30 : password().length <= 40 ? 22 : 16}px, max(16px, calc(100cqw / ${Math.max(1, Math.min(password().length, 20)) * 0.8})))`,
                    }}
                  >
                    <For each={password().split("")}>{(char) => <span style={{ color: tone(mode(), char) }}>{char}</span>}</For>
                  </span>
                </div>
              </Canvas>
              {/* the strength is a value with a limit: a bar and its word; 128 bits and more fill it */}
              <Inline>
                <Progress
                  value={Math.min(128, Math.round(strength().entropy))}
                  of={128}
                  label={
                    password()
                      ? `${t().strength}: ${t().strengthLabel({ word: t().strengthWord({ score: strength().score }), bits: Math.round(strength().entropy) })}`
                      : `${t().strength}: –`
                  }
                />
              </Inline>
              {/* what the password holds, as quiet chips: its length and its kinds of signs */}
              <Inline>
                <For each={contents()}>{(kind) => <Chip>{kind}</Chip>}</For>
              </Inline>
            </Section>
            <Show when={recent().length > 0}>
              <Section title={t().recent} count={recent().length} summary={t().recentHint}>
                <Facts items={recent().map((entry) => ({ label: entry.time, value: entry.value, mono: true, copy: entry.value }))} />
              </Section>
            </Show>
          </>
        }
        input={
          <Section title={w().settings} measure>
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
                <Slider min={8} max={64} value={randomLength()} onChange={setRandomLength} />
              </Field>
              <Check switch label={t().uppercase} checked={randomUppercase()} onChange={setRandomUppercase} />
              <Check switch label={t().numbers} checked={randomNumbers()} onChange={setRandomNumbers} />
              <Check switch label={t().symbols} checked={randomSymbols()} onChange={setRandomSymbols} />
            </Show>
            <Show when={mode() === "memorable"}>
              <Field label={t().words} optional="3–8">
                <Slider min={3} max={8} value={memorableWords()} onChange={setMemorableWords} />
              </Field>
              <Check switch label={t().capitalizeFirstLetter} checked={memorableCapitalize()} onChange={setMemorableCapitalize} />
              <Check switch label={t().useFullWords} checked={memorableFullWords()} onChange={setMemorableFullWords} />
              <Check switch label={t().addNumber} checked={memorableNumber()} onChange={setMemorableNumber} />
              <Check switch label={t().addSymbol} checked={memorableSymbol()} onChange={setMemorableSymbol} />
            </Show>
            <Show when={mode() === "pin"}>
              <Field label={t().digits} optional="4–12">
                <Slider min={4} max={12} value={pinLength()} onChange={setPinLength} />
              </Field>
            </Show>
          </Section>
        }
      />
    </ToolsScreen>
  );
}
