/** Characters of one streamed argument a live step receives: enough for a screen of source, small per update. */
export const AI_LIVE_ARG_TAIL_CHARS = 4096;
/** How often a step's streamed arguments are sent while the model writes them. */
export const AI_LIVE_ARGS_INTERVAL_MS = 250;
/** Longest top-level key the reader compares; longer keys are never streamed arguments. */
const MAX_KEY_CHARS = 256;

const ESCAPES: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

/** The end of one streamed value: at most twice the shown tail is kept, with the lines cut off before it. */
type Tail = { text: string; droppedLines: number };

/** A cut at `index` would leave the low half of a surrogate pair; step past it. */
const pairSafe = (text: string, index: number) => {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
};

const countLines = (text: string, end = text.length) => {
  let lines = 0;
  for (let index = 0; index < end; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  return lines;
};

export type LiveArgsView = { args: Record<string, string>; omittedLines: Record<string, number> };

/**
 * Reads the named top-level string arguments of a tool call while the model streams its JSON, one fragment at a time.
 * Each fragment is read once; nested values never count, and each value keeps only its end, so memory and work per
 * fragment stay bounded however long the argument grows. The text is display-only: the final arguments replace it.
 */
export const createLiveArgsReader = (keys: readonly string[], limit = AI_LIVE_ARG_TAIL_CHARS) => {
  const wanted = new Set(keys);
  const values = new Map<string, Tail>();
  let depth = 0;
  let inString = false;
  /** At depth 1 the next string is a key until its colon. */
  let expectKey = false;
  /** Pending escape: `"\\"` after a backslash, `"u…"` while reading its four hex digits. */
  let escape: string | null = null;
  let key = "";
  /** What the open string is: a key, a wanted value, or anything else. */
  let reading: { kind: "key" } | { kind: "value"; tail: Tail } | null = null;
  let lastKey: string | null = null;

  const append = (tail: Tail, text: string) => {
    if (!text) return;
    tail.text += text;
    if (tail.text.length <= limit * 2) return;
    const cut = pairSafe(tail.text, tail.text.length - limit);
    tail.droppedLines += countLines(tail.text, cut);
    tail.text = tail.text.slice(cut);
  };

  const push = (delta: string) => {
    let chunk = "";
    const flush = () => {
      if (reading?.kind === "value") append(reading.tail, chunk);
      else if (reading?.kind === "key") key += chunk;
      chunk = "";
    };
    /** Keeps one fragment's text bounded too: a value flushes every `limit` characters, a key stops at its cap. */
    const take = (text: string) => {
      if (reading?.kind === "key") {
        if (key.length + chunk.length < MAX_KEY_CHARS) chunk += text;
        return;
      }
      chunk += text;
      if (chunk.length >= limit) flush();
    };
    for (let index = 0; index < delta.length; index += 1) {
      const char = delta[index]!;
      if (inString) {
        if (escape !== null) {
          if (escape === "\\") {
            if (char === "u") escape = "u";
            else {
              if (reading) take(ESCAPES[char] ?? char);
              escape = null;
            }
          } else {
            escape += char;
            if (escape.length === 5) {
              if (reading) take(String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
              escape = null;
            }
          }
          continue;
        }
        if (char === "\\") {
          escape = "\\";
          continue;
        }
        if (char === '"') {
          flush();
          inString = false;
          if (reading?.kind === "key") {
            lastKey = key;
            // A repeated key replaces its value whatever the new value is, as JSON.parse keeps the last one.
            values.delete(key);
          }
          reading = null;
          continue;
        }
        if (reading) take(char);
        continue;
      }
      if (char === '"') {
        inString = true;
        if (depth === 1 && expectKey) {
          key = "";
          reading = { kind: "key" };
        } else if (depth === 1 && lastKey !== null && wanted.has(lastKey)) {
          const tail: Tail = { text: "", droppedLines: 0 };
          values.set(lastKey, tail);
          reading = { kind: "value", tail };
        } else reading = null;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
        if (depth === 1) expectKey = char === "{";
      } else if (char === "}" || char === "]") depth -= 1;
      else if (depth === 1 && char === ",") {
        expectKey = true;
        lastKey = null;
      } else if (depth === 1 && char === ":") expectKey = false;
    }
    flush();
  };

  /**
   * What a live step shows of each value read so far: at most the last `limit` characters, starting at a line when one
   * begins in them, and how many lines came before, so the step can number its lines like the whole value.
   */
  const view = (): LiveArgsView => {
    const args: Record<string, string> = {};
    const omittedLines: Record<string, number> = {};
    for (const [name, tail] of values) {
      let start = pairSafe(tail.text, Math.max(0, tail.text.length - limit));
      if (start > 0 || tail.droppedLines > 0) {
        const lineStart = tail.text.indexOf("\n", start - 1);
        if (lineStart >= 0 && lineStart < tail.text.length - 1) start = lineStart + 1;
      }
      args[name] = tail.text.slice(start);
      omittedLines[name] = tail.droppedLines + countLines(tail.text, start);
    }
    return { args, omittedLines };
  };

  return { push, view };
};
