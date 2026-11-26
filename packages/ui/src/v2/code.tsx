import { copyToClipboard, downloadFileFromContent } from "@k2b/stdlib/browser";
import { createMemo, createSignal, For, Show } from "solid-js";
import { type CodeDisplayLanguage, highlightCodeDisplayLines } from "../content/code-highlight";
import { useLocale } from "../intl/locale";
import { useUiMessages } from "../intl/messages";
import { Button } from "./button";
import { useCodeMessages } from "./code-messages";
import { custom, Icon } from "./marks";
import { useToast } from "./toast";

export type CodeLanguage = CodeDisplayLanguage;

export type CodeBlockProps = {
  /** The code, exactly as it is copied and downloaded. */
  code: string;
  /**
   * What the code is, such as "config.yaml" or "Privater Schlüssel": shown in the block's head, and the name of the
   * code for assistive technology and of its copy and download buttons.
   */
  label: string;
  /** Highlights the code in this language; without it, the code is plain text. */
  language?: CodeLanguage;
  /** Numbers the lines. */
  lineNumbers?: boolean;
  /**
   * Long lines: they scroll sideways inside the block (default), `true` wraps them, `"toggle"` lets the person switch
   * with a button in the head.
   */
  wrap?: boolean | "toggle";
  /** Offers to download the code as a file of this name, such as "cloud.env". */
  download?: string;
  /**
   * A secret, such as a private key: its signs are hidden until the person presses "Zeigen"; copy and download work
   * while it is hidden. The hidden code keeps the shape of the real one, so nothing moves when it shows.
   */
  secret?: boolean;
};

/**
 * The lines a block draws before "Alles zeigen": a config or a key shows whole, a long log or a generated file shows
 * its start and the person asks for the rest. It bounds the work of the first page (every line is highlighted markup).
 */
export const codeLinesShown = 200;

const languageNames: Partial<Record<CodeLanguage, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  script: "JavaScript",
  markdown: "Markdown",
  md: "Markdown",
  sql: "SQL",
};

/**
 * A hidden line in the shape of the real one: spaces and tabs kept, every run of signs a row of dots exactly as wide
 * (drawn by CSS at one `ch` a sign, so no font can make it wider or narrower than the code it hides).
 */
const Hidden = (props: { line: string }) => (
  <code>
    <For each={props.line.split(/(\s+)/u).filter((part) => part !== "")}>
      {(part) =>
        /^\s+$/u.test(part) ? part : <span class="k2-code-mask" style={custom({ "--k2-code-signs": String([...part].length) })} />
      }
    </For>
    {props.line === "" ? " " : null}
  </code>
);

/**
 * Code to read and copy, such as a config, a key or a command: monospace in the meta role (12/16), lines as written.
 * Its head names it, with the deeds on the right (show, wrap, download, copy); a copy says "Kopiert" in a toast. Long
 * lines scroll sideways inside the block, never the page; the block takes the keyboard focus for that. A long code
 * shows its first 200 lines and "Alles zeigen" below them.
 */
export const CodeBlock = (props: CodeBlockProps) => {
  const t = useCodeMessages();
  const ui = useUiMessages();
  const locale = useLocale();
  const toast = useToast();
  const [revealed, setRevealed] = createSignal(false);
  const [wrapped, setWrapped] = createSignal(props.wrap === true);
  const [all, setAll] = createSignal(false);
  const masked = () => props.secret === true && !revealed();
  const lines = createMemo(() => props.code.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n"));
  const shown = () => (all() ? lines() : lines().slice(0, codeLinesShown));
  // highlighted only while it shows: a hidden secret never reaches the page as text
  // the highlighter's classes (`hl-*`) in the namespace of v2.css
  const drawn = createMemo(() =>
    masked()
      ? shown()
      : highlightCodeDisplayLines(shown().join("\n"), props.language ?? "text").map((line) => line.replace(/class="hl-/g, 'class="k2-hl-')),
  );
  const rest = () => lines().length - shown().length;
  // the widest number of the whole code, so the column keeps its width when the rest shows
  const digits = () => (props.lineNumbers ? String(String(lines().length).length) : undefined);
  const copy = async () => {
    try {
      await copyToClipboard(props.code);
      toast(t().copied, { status: "ok" });
    } catch {
      toast(t().copyFailed, { status: "bad" });
    }
  };
  return (
    <div
      class="k2-code"
      data-k2-part="CodeBlock"
      data-wrap={wrapped() ? "" : undefined}
      data-masked={masked() ? "" : undefined}
      style={custom({ "--k2-code-digits": digits() })}
    >
      <div class="k2-code-head">
        <Icon name={props.secret ? "key" : "file-code"} />
        <span class="k2-code-label">{props.label}</span>
        <Show when={props.language && languageNames[props.language]}>{(name) => <span class="k2-code-language">{name()}</span>}</Show>
        <span class="k2-code-deeds">
          <Show when={props.secret}>
            <Button variant="ghost" icon={masked() ? "eye" : "eye-off"} onClick={() => setRevealed(masked())}>
              {masked() ? t().show : t().hide}
            </Button>
          </Show>
          <Show when={props.wrap === "toggle"}>
            <Button variant="ghost" icon="text-wrap" label={t().wrap} pressed={wrapped()} onClick={() => setWrapped(!wrapped())} />
          </Show>
          <Show when={props.download}>
            {(name) => (
              <Button
                variant="ghost"
                icon="download"
                label={`${ui().download}: ${props.label}`}
                onClick={() => downloadFileFromContent(props.code, name(), "text/plain")}
              />
            )}
          </Show>
          <Button variant="ghost" icon="copy" label={`${ui().copy}: ${props.label}`} onClick={() => void copy()} />
        </span>
      </div>
      {/* the lines scroll sideways here, never the page; the keyboard reaches them through the focus */}
      <div class="k2-code-body" role="region" aria-label={props.label} aria-description={masked() ? t().hidden : undefined} tabIndex={0}>
        <div class="k2-code-lines">
          <For each={drawn()}>
            {(line, index) => (
              <div class="k2-code-line">
                <Show when={props.lineNumbers}>
                  <span class="k2-code-number" aria-hidden="true">
                    {index() + 1}
                  </span>
                </Show>
                <Show when={!masked()} fallback={<Hidden line={line} />}>
                  <code innerHTML={line || " "} />
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={rest() > 0}>
        <div class="k2-code-more">
          <Button variant="text" onClick={() => setAll(true)}>
            {t().showAll({ lines: new Intl.NumberFormat(locale()).format(lines().length) })}
          </Button>
        </div>
      </Show>
    </div>
  );
};
