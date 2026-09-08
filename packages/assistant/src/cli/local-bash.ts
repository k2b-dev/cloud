import type { CloudAiLocalBashInput, CloudAiLocalBashOutput } from "@valentinkolb/cloud/ai";
import { CloudAiLocalBashInputSchema } from "@valentinkolb/cloud/ai/browser";

const LOCAL_BASH_TIMEOUT_MS = 120_000;
const LOCAL_BASH_MAX_STREAM_BYTES = 512 * 1024;

type BoundedText = { text: string; truncated: boolean };

const readBoundedText = async (stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<BoundedText> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let text = "";
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const kept = value.byteLength <= remaining ? value : value.subarray(0, remaining);
    text += decoder.decode(kept, { stream: true });
    remaining -= kept.byteLength;
    if (kept.byteLength < value.byteLength) truncated = true;
  }

  text += decoder.decode();
  return { text, truncated };
};

export const parseLocalBashInput = (value: unknown): CloudAiLocalBashInput | null => {
  const parsed = CloudAiLocalBashInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const deniedLocalBashResult = (): CloudAiLocalBashOutput => ({
  status: "denied",
  exitCode: null,
  stdout: "",
  stderr: "User denied this command.",
  truncated: false,
});

export const runLocalBash = async (
  command: string,
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; maxStreamBytes?: number } = {},
): Promise<CloudAiLocalBashOutput> => {
  let timedOut = false;
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");

  try {
    const child = Bun.spawn({
      cmd: ["/bin/bash", "-lc", command],
      cwd: options.cwd ?? process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const killProcessGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process already exited.
        }
      }
    };
    const onAbort = () => killProcessGroup();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup();
    }, options.timeoutMs ?? LOCAL_BASH_TIMEOUT_MS);
    const maxBytes = options.maxStreamBytes ?? LOCAL_BASH_MAX_STREAM_BYTES;
    try {
      if (options.signal?.aborted) killProcessGroup();
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBoundedText(child.stdout, maxBytes),
        readBoundedText(child.stderr, maxBytes),
      ]);
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      return {
        status: timedOut ? "timed_out" : "completed",
        exitCode: timedOut ? null : exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (timedOut) {
      return { status: "timed_out", exitCode: null, stdout: "", stderr: "Command timed out.", truncated: false };
    }
    return {
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : "Could not start the local Bash command.",
      truncated: false,
    };
  }
};
