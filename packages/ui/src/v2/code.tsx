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

/** Copies through a selection in a hidden field, for a page where the clipboard API is missing or refused. */
const copyBySelection = (text: string): boolean => {
  const before = document.activeElement;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.append(field);
  field.select();
  let done = false;
  try {
    done = document.execCommand("copy");
  } catch {
    done = false;
  }
  field.remove();
  if (before instanceof HTMLElement) before.focus({ preventScroll: true });
  return done;
};

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
 * The highlighter's classes (`hl-*` for scripts, `cd-*` for SQL and Markdown) in the namespace of v2.css: every class
 * of a token gets `k2-` before it. Only the highlighter's own spans: the code's text is escaped (a `<` never stands as
 * itself in it), but its quotes are not, so a `class="…"` written in the code stays as written.
 */
const inNamespace = (line: string) =>
  line.replace(
    /<span class="([^"]*)"/g,
    (_attribute, classes: string) =>
      `<span class="${classes
        .split(" ")
        .map((name) => `k2-${name}`)
        .join(" ")}"`,
  );

/** The signs of a run as a person sees them: a letter with its accents or an emoji is one sign. */
const signs = (run: string) =>
  typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(run)].length
    : [...run].length;

/**
 * A hidden line in the shape of the real one: spaces and tabs kept, every run of signs a row of dots exactly as wide
 * (drawn by CSS at one `ch` a sign, so no font can make it wider or narrower than the code it hides). A wide sign
 * (such as a CJK character) takes two places when it shows; a key or a config has none.
 */
const Hidden = (props: { line: string }) => (
  <code>
    <For each={props.line.split(/(\s+)/u).filter((part) => part !== "")}>
      {(part) => (/^\s+$/u.test(part) ? part : <span class="k2-code-mask" style={custom({ "--k2-code-signs": String(signs(part)) })} />)}
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
  // the highlighter's classes in the namespace of v2.css
  const drawn = createMemo(() =>
    masked() ? shown() : highlightCodeDisplayLines(shown().join("\n"), props.language ?? "text").map(inNamespace),
  );
  const rest = () => lines().length - shown().length;
  // the widest number of the whole code, so the column keeps its width when the rest shows
  const digits = () => (props.lineNumbers ? String(String(lines().length).length) : undefined);
  let body: HTMLDivElement | undefined;
  const copy = async () => {
    const done = await copyToClipboard(props.code).then(
      () => true,
      // a page without the clipboard API (plain HTTP) or without its permission: the selection way, as browsers had it
      () => copyBySelection(props.code),
    );
    if (done) toast(t().copied, { status: "ok" });
    // a hidden code cannot be selected by hand: the sentence says to show it first
    else toast(masked() ? t().copyFailedHidden : t().copyFailed, { status: "bad" });
  };
  const showAll = () => {
    setAll(true);
    // the button goes; the focus goes to the lines, which now hold the rest
    body?.focus({ preventScroll: true });
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
            {/* one word in both states (a toggle), so the button keeps its width */}
            <Button variant="ghost" icon="eye" pressed={revealed()} onClick={() => setRevealed(!revealed())}>
              {t().show}
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
      <div
        ref={body}
        class="k2-code-body"
        role="region"
        aria-label={masked() ? t().hiddenName({ name: props.label }) : props.label}
        tabIndex={0}
      >
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
          <Button variant="text" onClick={showAll}>
            {t().showAll({ lines: new Intl.NumberFormat(locale()).format(lines().length) })}
          </Button>
        </div>
      </Show>
    </div>
  );
};
