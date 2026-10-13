type Output = { bytes: number; eof: boolean; text: string };
type Timing = { name: string; start: number; duration?: number };
type Entry =
  | (Timing & { kind: "phase"; failed: boolean })
  | (Timing & { kind: "process"; child: Bun.Subprocess<"ignore", "pipe", "pipe">; exited: boolean; stdout: Output; stderr: Output });

/** Record test steps and children without exposing their commands or environment. */
export type ProcessTrace = {
  phase<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  spawn(
    name: string,
    command: string[],
    options: { cwd?: string; env?: Record<string, string | undefined> },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
};

const consume = async (stream: ReadableStream<Uint8Array>, output: Output) => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        output.text += decoder.decode();
        output.eof = true;
        return;
      }
      output.bytes += value.byteLength;
      output.text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
};

/** Report failures or an approaching deadline, keeping partial child output. */
export const traced = (timeoutMs: number, body: (trace: ProcessTrace) => Promise<void>) => async () => {
  const start = performance.now();
  const elapsed = () => performance.now() - start;
  const entries: Entry[] = [];
  let reported = false;
  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    const lines = [`${reason} after ${Math.round(elapsed())} ms; process trace:`];
    for (const entry of entries) {
      const timing = entry.duration === undefined ? `running since ${Math.round(entry.start)} ms` : `${Math.round(entry.duration)} ms`;
      let line = `${entry.name}: start ${Math.round(entry.start)} ms, ${timing}`;
      if (entry.kind === "phase") {
        lines.push(`${line}${entry.failed ? ", failed" : ""}`);
        continue;
      }
      line += `, pid ${entry.child.pid}, exited=${entry.exited ? "yes" : "no"}, exitCode=${entry.child.exitCode}, signalCode=${entry.child.signalCode}`;
      const outputs = Object.entries({ stdout: entry.stdout, stderr: entry.stderr });
      for (const [name, output] of outputs) {
        line += `, ${name} ${output.bytes} bytes EOF=${output.eof ? "yes" : "no"}`;
      }
      lines.push(line);
      for (const [name, output] of outputs) {
        if (output.text) lines.push(`  ${name} tail:\n${output.text.slice(-2000).replace(/^/gm, "    ")}`);
      }
    }
    console.error(lines.join("\n"));
  };
  const trace: ProcessTrace = {
    async phase(name, fn) {
      const entry: Entry = { kind: "phase", name, start: elapsed(), failed: false };
      entries.push(entry);
      try {
        return await fn();
      } catch (error) {
        entry.failed = true;
        throw error;
      } finally {
        entry.duration = elapsed() - entry.start;
      }
    },
    async spawn(name, command, options) {
      const offset = elapsed();
      const child = Bun.spawn(command, { ...options, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const entry: Entry = {
        kind: "process",
        name,
        start: offset,
        child,
        exited: false,
        stdout: { bytes: 0, eof: false, text: "" },
        stderr: { bytes: 0, eof: false, text: "" },
      };
      entries.push(entry);
      const [exitCode] = await Promise.all([
        child.exited.then((code) => {
          entry.exited = true;
          entry.duration = elapsed() - entry.start;
          return code;
        }),
        consume(child.stdout, entry.stdout),
        consume(child.stderr, entry.stderr),
      ]);
      return { exitCode, stdout: entry.stdout.text, stderr: entry.stderr.text };
    },
  };
  const watchdog = setTimeout(() => report("Test is close to its deadline"), timeoutMs - 5000);
  watchdog.unref();
  try {
    await body(trace);
  } catch (error) {
    report("Test failed");
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
};
