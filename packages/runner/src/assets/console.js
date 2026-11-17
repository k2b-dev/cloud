// Executed inside one fresh dynamic isolate. It has no lease, process log or credential.
export function createCodeConsole(cloud, limits) {
  const encoder = new TextEncoder();
  const bytes = (value) => encoder.encode(JSON.stringify(value)).length;
  const sum = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  let entries = [],
    droppedLines = 0,
    droppedBytes = 0,
    seq = 0;
  let sending,
    lastAt = 0,
    failed = false;
  const batch = () => ({ seq: seq + 1, entries, droppedLines, droppedBytes });
  const drop = (line) => {
    droppedLines = sum(droppedLines, 1);
    droppedBytes = sum(droppedBytes, bytes(line));
  };
  const append = (level, args) => {
    let text;
    try {
      text = args
        .map((value) => {
          if (typeof value === "string") return value;
          if (value instanceof Error) return value.stack || value.message;
          if (typeof value === "bigint") return String(value);
          return JSON.stringify(value) ?? String(value);
        })
        .join(" ");
    } catch {
      text = "[unprintable]";
    }
    const at = new Date().toISOString();
    for (const textLine of text.split(/\r\n|\n|\r/)) {
      const line = { kind: "log", level, at, text: textLine };
      if (bytes({ ...batch(), entries: [line] }) > limits.bytes) {
        drop(line);
        continue;
      }
      entries.push(line);
      while (entries.length && bytes(batch()) > limits.bytes) drop(entries.shift());
    }
  };
  const send = async () => {
    if ((!entries.length && !droppedLines && !droppedBytes) || Date.now() - lastAt < limits.intervalMs) return;
    const value = { seq: ++seq, entries, droppedLines, droppedBytes };
    entries = [];
    droppedLines = 0;
    droppedBytes = 0;
    lastAt = Date.now();
    try {
      await cloud.call(limits.operation, value);
    } catch {
      for (const line of value.entries) drop(line);
      droppedLines = sum(droppedLines, value.droppedLines);
      droppedBytes = sum(droppedBytes, value.droppedBytes);
      failed = true;
    } finally {
      lastAt = Date.now();
    }
  };
  const flush = () => {
    if (sending) return sending;
    sending = send().finally(() => {
      sending = undefined;
    });
    return sending;
  };
  const console = Object.freeze(
    Object.fromEntries(["log", "info", "debug", "warn", "error"].map((level) => [level, (...args) => append(level, args)])),
  );
  // runtime-timer: flush only while this sandbox invocation is in flight; finish clears and joins it.
  const timer = setInterval(() => {
    void flush();
  }, limits.intervalMs);
  return {
    console,
    async finish() {
      clearInterval(timer);
      await sending;
      if (entries.length || droppedLines || droppedBytes) {
        const remaining = limits.intervalMs - (Date.now() - lastAt);
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        await flush();
      }
      if (failed) throw new Error("code_output_unavailable");
    },
  };
}
