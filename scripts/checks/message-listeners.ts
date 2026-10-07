import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Receivers whose `message` events can come from any window: frames, popups, openers and the page itself. */
const WINDOW_RECEIVER = /(?:^|[^\w$.?])(?:(?:window|self|globalThis|parent|top)\s*\??\.\s*)?$/;
const LISTENER = /addEventListener\(\s*["']message["']\s*,\s*/g;
const PROPERTY = /(?<![\w$.])(?:window|self|globalThis)\s*\.\s*onmessage\s*=\s*/g;

/** The text from `start` to the bracket that closes the one open before it, skipping strings. */
const balanced = (source: string, start: number, open = "(", close = ")"): string => {
  let depth = 1;
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return source.slice(start, index);
  }
  return source.slice(start);
};

/** The handler's code: an inline function, or the function a named handler refers to in the same file. */
const handlerCode = (source: string, start: number, call: boolean): string => {
  const name = /^([A-Za-z_$][\w$]*)\s*(?:[,);\n]|$)/.exec(source.slice(start))?.[1];
  if (!name) {
    if (call) return balanced(source, start);
    const body = source.indexOf("{", start);
    return body < 0 ? "" : balanced(source, body + 1, "{", "}");
  }
  const definition = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=)`).exec(source);
  if (!definition) return "";
  const body = source.indexOf("{", definition.index);
  return body < 0 ? "" : balanced(source, body + 1, "{", "}");
};

/**
 * Any window can post a `message` event to a Cloud page or frame. A listener that does not compare
 * `event.source` with the window it expects acts on foreign messages (a confused deputy). Listeners on
 * sockets, ports, channels, workers or service workers receive only from their own peer and are not checked.
 */
export const rule: Rule = {
  name: "message-listeners",
  description: "every window message listener checks event.source",
  run: async ({ workspaceRoot }) => {
    const roots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(root, /\.(?:ts|tsx)$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("message")) continue;
      for (const pattern of [LISTENER, PROPERTY]) {
        for (const match of source.matchAll(pattern)) {
          const at = match.index!;
          if (pattern === LISTENER && !WINDOW_RECEIVER.test(source.slice(Math.max(0, at - 40), at))) continue;
          if (/\.source\b/.test(handlerCode(source, at + match[0].length, pattern === LISTENER))) continue;
          findings.push({
            file,
            line: source.slice(0, at).split("\n").length,
            message: "This message listener acts on messages from any window. Compare event.source with the window you expect first.",
          });
        }
      }
    }
    return findings.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
  },
};
