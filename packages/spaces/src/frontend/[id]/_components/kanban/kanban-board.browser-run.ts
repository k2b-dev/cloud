import { expect, test } from "bun:test";
import type { KanbanPart } from "./kanban-board.browser-suite";

/** The bound of one part's child process: the bound the whole suite had before it was split (#3026). */
const budget = 180_000;
/** The wrapper stops its child this long before Bun's own timeout, so it can still say what the child did. */
const reportMargin = 15_000;

/**
 * Defines one part of the Spaces Kanban browser suite in a test file. The suite registers the SSR island plugin
 * for its whole process; run alone, no other test file's plugin can transform its fixture first and give the island
 * an ID the browser bundle does not know. The child runs only `part` of `kanban-board.browser-suite.ts`. Its output
 * is collected while it runs. When the part fails or runs out of its budget, the wrapper prints it; out of budget,
 * it also names the last case that finished, so the case after it is the slow one (#3026). Bun lists passing cases
 * only outside agent sessions, as in CI. Each test file passes `browserName` itself: the root runner takes a file
 * that imports `packages/ui/test/browser` for a browser test.
 */
export const defineKanbanPart = async (file: string, part: KanbanPart, title: string, browserName: string) => {
  if (process.env.SPACES_KANBAN_BROWSER_CHILD === "1") {
    await import("./kanban-board.browser-suite");
    return;
  }
  test(
    `${title} in ${browserName}`,
    async () => {
      const child = Bun.spawn([process.execPath, "test", file], {
        env: { ...process.env, SPACES_KANBAN_BROWSER_CHILD: "1", SPACES_KANBAN_PART: part },
        stdout: "pipe",
        stderr: "pipe",
      });
      let output = "";
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
      };
      const streams = Promise.all([collect(child.stdout), collect(child.stderr)]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), budget - reportMargin);
      });
      const code = await Promise.race([child.exited, expiry]).finally(() => clearTimeout(timer));
      if (code === "expired") {
        child.kill("SIGKILL");
        await child.exited;
      }
      await streams;
      const finished = [...output.matchAll(/^\((?:pass|fail|skip)\) (.+?)(?: \[[\d.]+ms\])?$/gm)].at(-1)?.[1];
      const notice =
        code === "expired"
          ? `The part ran out of its ${(budget - reportMargin) / 1000} s budget. Last finished case: ${finished ?? "none reported"}; the next one was still running.\n`
          : "";
      expect({ code, output: code === 0 ? "passed" : `${notice}${output}` }).toEqual({ code: 0, output: "passed" });
    },
    budget,
  );
};
