import { expect, test } from "bun:test";
import type { MailShellPart } from "./mail-shell.browser-suite";

/**
 * Defines one part of the Mail shell suite in a test file. The island plugin owns its child process so SSR IDs and
 * browser bundles agree. The child's cases are separate tests with the suite's 20 s budget each. Their failures and
 * start lines stream into this log as they happen, and the slowest cases follow the result, so a slow case is named
 * even when this file's own timeout cuts the run off (#1966).
 */
export const defineMailShellPart = async (
  file: string,
  part: MailShellPart,
  browserName: string,
  env: Record<string, string | undefined>,
) => {
  if (env.MAIL_SHELL_BROWSER_CHILD === "1") {
    const { defineMailShellTests } = await import("./mail-shell.browser-suite");
    defineMailShellTests(part, env.MAIL_SHELL_SCREENSHOTS);
    return;
  }
  // The bound of the whole file. CI needs a fraction of it; a loaded development machine needs more.
  test(`Mail SSR shell ${part} in ${browserName}`, async () => {
    const child = Bun.spawn([process.execPath, "test", file], {
      env: { ...env, MAIL_SHELL_BROWSER_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Case times are summarized below, not repeated line by line.
    const forward = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
      const decoder = new TextDecoder();
      let text = "";
      let pending = "";
      for await (const chunk of stream) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split("\n");
        pending = lines.pop()!;
        for (const line of lines) if (!line.startsWith("[mail-shell] end ")) sink.write(`${line}\n`);
        text += lines.map((line) => `${line}\n`).join("");
      }
      if (pending) sink.write(pending);
      return text + pending;
    };
    try {
      const [stdout, stderr, code] = await Promise.all([
        forward(child.stdout, process.stdout),
        forward(child.stderr, process.stderr),
        child.exited,
      ]);
      const output = `${stdout}\n${stderr}`.split("\n");
      const cases = output
        .flatMap((line) => {
          const match = /^\[mail-shell\] end ([\d.]+) s (.*)$/.exec(line);
          return match ? [{ seconds: Number(match[1]), name: match[2]! }] : [];
        })
        .sort((a, b) => b.seconds - a.seconds);
      console.info(
        `Slowest Mail shell ${part} cases in ${browserName}:\n${cases
          .slice(0, 5)
          .map(({ name, seconds }) => `  ${seconds.toFixed(1)} s  ${name}`)
          .join("\n")}`,
      );
      const failed = output.filter((line) => line.startsWith("(fail)"));
      expect({ code, failed, ran: cases.length > 0 }).toEqual({ code: 0, failed: [], ran: true });
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  }, 300_000);
};
