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
  const enqueue = (entry) => {
    if (limits.enabled === false) return;
    if (bytes({ ...batch(), entries: [entry] }) > limits.bytes) return drop(entry);
    // Coalesce only adjacent revisions of this handle: crossing another entry
    // would move completion text before it and change the continuous text stream.
    const position = entry.kind === "step" ? entries.findLastIndex((old) => old.kind === "step" && old.id === entry.id) : -1;
    if (position < 0 || entries.slice(position + 1).some((old) => old.kind !== "step" || old.id !== entry.id)) entries.push(entry);
    else entries[position] = entry;
    while (entries.length && bytes(batch()) > limits.bytes) {
      const log = entries.findIndex((old) => old.kind !== "step");
      drop(entries.splice(Math.max(0, log), 1)[0]);
    }
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
      enqueue(line);
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
  // Lifetime IDs and retained handle metadata share the canonical output budget.
  // The trusted host derives field/count limits from the serialized live-frame contract.
  const steps = new Map();
  let stepBytes = bytes({});
  const refuse = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const checkText = (value) => {
    if (typeof value !== "string") refuse("code_output_invalid_text");
    return clipped(value);
  };
  const clipped = (value, budget = limits.step.textBytes) => {
    let end = value.length;
    if (bytes(value) <= budget) return value;
    let start = 0;
    while (start < end) {
      const middle = Math.ceil((start + end) / 2);
      if (bytes(value.slice(0, middle)) <= budget) start = middle;
      else end = middle - 1;
    }
    return value.slice(0, end);
  };
  const terminal = (status) => ["succeeded", "failed", "skipped"].includes(status);
  // Reserve lifecycle timestamps at creation, so an automatic failure can always settle.
  const stepCost = (entry) =>
    limits.step.metadataBytes +
    ["label", "icon", "description", "message"].reduce(
      (size, field) => size + Math.max(0, bytes(entry[field] ?? "") - bytes("") - limits.step.textReserveBytes),
      0,
    );
  const update = (entry) => {
    const previous = steps.get(entry.id);
    const nextBytes = stepBytes - (previous ? stepCost(previous) : 0) + stepCost(entry);
    if (nextBytes > limits.step.budget) return false;
    stepBytes = nextBytes;
    steps.set(entry.id, entry);
    enqueue(entry);
    return true;
  };
  const noop = Object.freeze({ start() {}, succeed() {}, fail() {}, skip() {} });
  const logger = Object.freeze({
    ...Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (text) => {
          if (typeof text !== "string") refuse("code_output_invalid_text");
          append(level, [text]);
        },
      ]),
    ),
    step(label, options = {}) {
      if (label && typeof label === "object") {
        options = label;
        label = options.label;
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) refuse("code_output_invalid_step");
      const id = steps.size + 1;
      const entry = {
        kind: "step",
        id,
        at: new Date().toISOString(),
        label: checkText(label),
        status: "pending",
        ...(options.icon === undefined ? {} : { icon: checkText(options.icon) }),
        ...(options.description === undefined ? {} : { description: checkText(options.description) }),
      };
      if (entry.icon !== undefined && (entry.icon.length > 64 || !/^[a-z0-9-]+$/.test(entry.icon))) delete entry.icon;
      if (steps.size >= limits.step.count || !update(entry)) {
        drop(entry);
        return noop;
      }
      const settle = (status, message) => {
        const current = steps.get(id);
        if (terminal(current.status) || (current.status === "pending" && status === "succeeded")) return;
        if ((status === "failed" || status === "skipped") && message === undefined) refuse("code_output_invalid_text");
        const base = { ...current, status, endedAt: new Date().toISOString() };
        // Keep the original handle metadata; completion text uses its remaining
        // share of the canonical reservation instead of throwing into author code.
        const available = limits.step.budget - stepBytes + stepCost(current) - stepCost({ ...base, message: "" });
        update({
          ...base,
          ...(message === undefined
            ? {}
            : { message: clipped(checkText(message), Math.max(bytes(""), available + bytes("") + limits.step.textReserveBytes)) }),
        });
      };
      return Object.freeze({
        start() {
          const current = steps.get(id);
          if (current.status !== "pending") return;
          update({ ...current, status: "running", startedAt: new Date().toISOString() });
        },
        succeed: (message) => settle("succeeded", message),
        fail: (reason) => settle("failed", reason),
        skip: (reason) => settle("skipped", reason),
      });
    },
  });
  // runtime-timer: flush only while this sandbox invocation is in flight; finish clears and joins it.
  const timer =
    limits.enabled === false
      ? undefined
      : setInterval(() => {
          void flush();
        }, limits.intervalMs);
  return {
    console,
    logger,
    error(error) {
      let text = "[unprintable]";
      try {
        text = String(error instanceof Error ? error.message : error);
      } catch {
        /* Preserve settlement for unprintable throws. */
      }
      for (const entry of steps.values())
        if (entry.status === "running") {
          const base = { ...entry, status: "failed", endedAt: new Date().toISOString(), message: "" };
          const remaining = limits.step.budget - stepBytes + stepCost(entry) - stepCost(base);
          const message = clipped(
            text,
            Math.min(limits.step.textBytes, Math.max(bytes(""), remaining + bytes("") + limits.step.textReserveBytes)),
          );
          update({ ...base, message });
        }
      console.error(error);
    },
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
