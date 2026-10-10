import { type Completer, createInterface, type Key } from "node:readline";
import { completeLocalPath } from "./local-paths";
import { terminalInfo } from "./terminal";

export type LineReader = {
  readMessage(prompt: string): Promise<string | null>;
  read(prompt: string, options?: { typedOnly?: boolean }): Promise<string | null>;
  close(): void;
  onInterrupt(handler: () => void): () => void;
  pause?(): void;
  resume?(): void;
};

type PendingRead = {
  message: boolean;
  typedOnly: boolean;
  prompt: string;
  lines: string[];
  pasted: boolean;
  resolve(value: string | null): void;
};

/** Read chat messages and deliberate answers without consuming input typed during a turn. */
export const createLineReader = (
  options: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; completer?: Completer; cwd?: string } = {},
): LineReader => {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin;
  const output: NodeJS.WritableStream = options.output ?? process.stdout;
  const cwd = options.cwd ?? process.cwd();
  const rl = createInterface({
    input,
    output,
    terminal: true,
    completer:
      options.completer ??
      ((line: string) => {
        const token = line.split(/\s+/).at(-1) ?? "";
        return [token.startsWith("@") ? completeLocalPath(token, cwd) : [], token];
      }),
  });
  const terminal = "isTTY" in output && output.isTTY === true;
  const interrupts = new Set<() => void>();
  let closed = false;
  let pending: PendingRead | undefined;
  let pasting = false;
  let pastedSinceLine = false;
  let idleNotice = false;
  let bracketedPaste = false;
  const setBracketedPaste = (enabled: boolean) => {
    if (!terminal || bracketedPaste === enabled) return;
    output.write(enabled ? "\x1b[?2004h" : "\x1b[?2004l");
    bracketedPaste = enabled;
  };
  const prompt = (value: string) => {
    rl.setPrompt(value);
    rl.prompt();
  };
  const clearLine = () => {
    // Bun ignores Ctrl+U/Ctrl+K through rl.write; reset both documented properties.
    Object.assign(rl, { line: "", cursor: 0 });
  };
  const onKeypress = (_text: string, key: Key) => {
    if (key.name === "paste-start") {
      pasting = true;
      pastedSinceLine = true;
      if (pending) pending.pasted = true;
    } else if (key.name === "paste-end") pasting = false;
    else if (pasting && key.name !== "return" && key.name !== "enter") {
      pastedSinceLine = true;
      if (pending) pending.pasted = true;
    }
  };
  input.on("keypress", onKeypress);
  rl.on("line", (line: string) => {
    const pasted = pasting || pastedSinceLine;
    pastedSinceLine = false;
    if (!pending) {
      if (!idleNotice) {
        output.write(`${terminalInfo("Input is ignored while the Assistant works. Wait for the prompt, or press Ctrl+C to stop.")}\n`);
        idleNotice = true;
      }
      return;
    }
    pending.pasted ||= pasted;
    if (pending.typedOnly && pending.pasted) {
      pending.lines = [];
      pending.pasted = false;
      output.write("Pasted input does not answer this question. Type your answer.\n");
      prompt(pending.prompt);
      return;
    }
    if (pasting) {
      pending.lines.push(line);
      return;
    }
    if (pending.message && !pasted && /(?<!\\)\\$/.test(line)) {
      pending.lines.push(line.slice(0, -1));
      prompt("  ");
      return;
    }
    const read = pending;
    pending = undefined;
    read.resolve([...read.lines, line].join("\n"));
  });
  rl.on("SIGINT", () => {
    if (pending?.message && (rl.line || pending.lines.length > 0)) {
      clearLine();
      pending.lines = [];
      pending.pasted = false;
      pastedSinceLine = false;
      output.write("\n");
      prompt(pending.prompt);
      return;
    }
    for (const handler of interrupts) handler();
  });
  rl.once("close", () => {
    closed = true;
    setBracketedPaste(false);
    input.removeListener("keypress", onKeypress);
    pending?.resolve(null);
    pending = undefined;
  });
  setBracketedPaste(true);
  const read = (value: string, message: boolean, typedOnly = false): Promise<string | null> => {
    if (closed) return Promise.resolve(null);
    clearLine();
    pastedSinceLine = pasting;
    idleNotice = false;
    return new Promise((resolve) => {
      pending = { message, typedOnly, prompt: value, lines: [], pasted: pasting, resolve };
      prompt(value);
    });
  };
  return {
    readMessage: (prompt) => read(prompt, true),
    read: (prompt, options) => read(prompt, false, options?.typedOnly),
    close: () => rl.close(),
    pause: () => {
      setBracketedPaste(false);
      rl.pause();
    },
    resume: () => {
      if (closed) return;
      rl.resume();
      setBracketedPaste(true);
    },
    onInterrupt(handler) {
      interrupts.add(handler);
      return () => interrupts.delete(handler);
    },
  };
};
