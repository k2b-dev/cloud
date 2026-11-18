import { expect, spyOn, test } from "bun:test";
import {
  bindOutputPending,
  compileOutputRedaction,
  type OutputRedactionPending,
  OutputRedactionPendingSchema,
  type OutputSteps,
  redactOutput,
} from "./output-redaction";
import { secretEchoReplacements } from "./secret-echo";

const line = (text: string) => ({ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log" as const, text });
const value = 'abcdefgh /+"value';
const replacements = secretEchoReplacements([{ name: "TOKEN", value, sent: `Bearer ${value}` }]);
for (const spelling of replacements.keys()) {
  for (const boundary of ["line", "batch"] as const) {
    test(`harden output redaction at ${boundary} boundaries for ${Buffer.from(spelling).toString("hex")}`, () => {
      const redactor = compileOutputRedaction(replacements);
      const middle = Math.floor(spelling.length / 2);
      const left = spelling.slice(0, middle),
        right = spelling.slice(middle);
      const first = redactOutput([line(left)], redactor);
      expect(first.entries.flatMap((line) => line.text)).toEqual([]);
      expect(first.pending!.text.length).toBeLessThan(redactor.longest);
      const result =
        boundary === "batch" ? redactOutput([line(right)], redactor, first.pending) : redactOutput([line(left), line(right)], redactor);
      const finished = redactOutput([], redactor, result.pending, true);
      const parts = [...result.entries, ...finished.entries].flatMap((line) => line.text);
      expect(parts.filter((part) => part.type === "secret")).toEqual([{ type: "secret", name: "TOKEN" }]);
      expect(parts.filter((part) => part.type === "text")).toEqual([]);
    });
  }
}
test("harden unfinished output fragments at finalization and keep the pending suffix bounded", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  for (const text of ["ab", "cd", "ef"]) {
    const result = redactOutput([line(text)], redactor, pending);
    expect(result.entries.flatMap((line) => line.text)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([], redactor, pending, true).entries).toEqual([
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "secret", name: "TOKEN" }] },
  ]);
});
test("harden longest-match handling while releasing resolved ordinary text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:SHORT]"],
      ["abcdef", "[secret:LONG]"],
    ]),
  );
  const first = redactOutput([line("prefix abc")], redactor);
  expect(first.entries).toEqual([
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "prefix " }] },
  ]);
  expect(redactOutput([line("def tail")], redactor, first.pending).entries.flatMap((line) => line.text)).toEqual([
    { type: "secret", name: "LONG" },
    { type: "text", text: " tail" },
  ]);
  const mismatch = redactOutput([line("ab"), line("x")], redactor);
  expect(mismatch.pending).toBeNull();
  expect(mismatch.entries.map((line) => line.text)).toEqual([[{ type: "text", text: "ab" }], [{ type: "text", text: "x" }]]);
});

for (const boundary of ["line", "batch"] as const) {
  test(`harden Unicode output continuity at ${boundary} boundaries`, () => {
    const redactor = compileOutputRedaction(new Map([["ab😀cd", "[secret:TOKEN]"]]));
    const value = "ab😀cd";
    const left = line(value.slice(0, 3));
    const right = line(value.slice(3));
    const first = redactOutput([left], redactor);
    expect(first.entries.flatMap((line) => line.text)).toEqual([]);
    const result = boundary === "batch" ? redactOutput([right], redactor, first.pending) : redactOutput([left, right], redactor);
    expect(result.entries.flatMap((line) => line.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(result.pending).toBeNull();
  });
}

test("deferred structured entries retain their original kind, level and timestamp", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const first = { ...line("abcd"), level: "error" as const };
  const second = { ...line("efgh tail"), at: "2030-01-02T00:00:01.000Z", level: "warn" as const };
  const pending = redactOutput([first], redactor).pending;
  const result = redactOutput([second], redactor, pending);
  expect(result.entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
    { kind: second.kind, level: second.level, at: second.at, text: [{ type: "text", text: " tail" }] },
  ]);
  expect(redactOutput([], redactor, pending, true).entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
  ]);
});

for (const boundary of ["batch", "following fragments"] as const) {
  test(`harden pending output when loss precedes ${boundary}`, () => {
    const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
    const accepted = redactOutput([line("abcd")], redactor);
    expect(accepted.entries.flatMap((entry) => entry.text)).toEqual([]);
    const lost = redactOutput(boundary === "batch" ? [line("normal")] : [], redactor, accepted.pending, false, { lost: true, skip: 0 });
    expect(lost.entries.flatMap((entry) => entry.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(lost.pending).toBeNull();
    expect(lost.skip).toBe(redactor.longest - 1);
    // The missing continuation may be inside the reported batch or between it
    // and later fragments. Keep the conservative suffix across both boundaries.
    const following = redactOutput([line("gh")], redactor, lost.pending, false, { lost: false, skip: lost.skip });
    expect(following.entries).toEqual([]);
    expect(following.dropped.lines).toBe(1);
    const ordinary = redactOutput([line("normal")], redactor, following.pending, false, { lost: false, skip: following.skip });
    expect(ordinary.entries).toEqual([]);
    expect(ordinary.skip).toBe(0);
    expect(ordinary.dropped.bytes).toBe(Buffer.byteLength(JSON.stringify(line("normal"))));
    const restored = redactOutput([line("later")], redactor, ordinary.pending, false, { lost: false, skip: ordinary.skip });
    expect(restored.entries.flatMap((entry) => entry.text)).toEqual([{ type: "text", text: "later" }]);
  });
}
for (const spelling of replacements.keys()) {
  test(`harden deferred encoded output across a gap for ${Buffer.from(spelling).toString("hex")}`, () => {
    const redactor = compileOutputRedaction(replacements);
    const middle = Math.floor(spelling.length / 2);
    const accepted = redactOutput([line(spelling.slice(0, middle))], redactor);
    const lost = redactOutput([line(spelling.slice(middle)), line("ordinary")], redactor, accepted.pending, false, { lost: true, skip: 0 });
    expect(lost.entries.flatMap((entry) => entry.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(lost.dropped.lines).toBe(2);
    const following = redactOutput([line(".".repeat(redactor.longest))], redactor, lost.pending, false, { lost: false, skip: lost.skip });
    expect(following.entries).toEqual([]);
    expect(following.skip).toBe(0);
  });
}

test("harden repetitive prefix matching with a deterministic linear transition bound", () => {
  const redactor = compileOutputRedaction(new Map([["a".repeat(6000) + "b", "[secret:TOKEN]"]]));
  const nodes = [redactor.root];
  for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.next.values());
  let comparisons = 0;
  const lookups = nodes.map((node) => {
    const get = node.next.get.bind(node.next);
    return spyOn(node.next, "get").mockImplementation((char) => {
      comparisons++;
      return get(char);
    });
  });
  try {
    const text = "a".repeat(10 * 1024);
    const result = redactOutput([line(text)], redactor);
    expect(comparisons).toBeGreaterThanOrEqual(text.length);
    expect(comparisons).toBeLessThanOrEqual(2 * text.length);
    expect(result.pending?.text.length).toBeLessThan(redactor.longest);
  } finally {
    for (const lookup of lookups) lookup.mockRestore();
  }
});

test("harden failure suffixes and overlapping matches without releasing covered text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abcd", "[secret:FIRST]"],
      ["cdef", "[secret:SECOND]"],
      ["abz", "[secret:THIRD]"],
      ["bz", "[secret:FOURTH]"],
    ]),
  );
  expect(redactOutput([line("abcdef abz bz!")], redactor, null, true).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "FIRST" },
    { type: "text", text: " " },
    { type: "secret", name: "THIRD" },
    { type: "text", text: " " },
    { type: "secret", name: "FOURTH" },
    { type: "text", text: "!" },
  ]);
});

test("harden pending failure suffixes after a completed match", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:FIRST]"],
      ["bcdefghi", "[secret:SECOND]"],
      ["ghijk", "[secret:THIRD]"],
    ]),
  );
  const first = redactOutput([line("abcdefgh")], redactor);
  expect(first.entries.flatMap((entry) => entry.text)).toEqual([]);
  expect(first.pending?.text).toBe("bcdefgh");
  expect(first.pending!.text.length).toBeLessThan(redactor.longest);
  const second = redactOutput([line("i")], redactor, first.pending);
  expect(second.entries.flatMap((entry) => entry.text)).toEqual([]);
  expect(second.pending?.text).toBe("ghi");
  expect(redactOutput([line("jk!")], redactor, second.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "FIRST" },
    { type: "text", text: "!" },
  ]);
});

for (const spelling of replacements.keys()) {
  for (const boundary of ["line", "batch"] as const) {
    test(`harden suppressed end candidates at ${boundary} boundaries for ${Buffer.from(spelling).toString("hex")}`, () => {
      const redactor = compileOutputRedaction(replacements);
      const middle = Math.floor(spelling.length / 2);
      const lost = redactOutput([], redactor, null, false, { lost: true, skip: 0 });
      const muted = line(".".repeat(redactor.longest) + spelling.slice(0, middle));
      const continuation = line(spelling.slice(middle) + "!");
      const first = redactOutput([muted], redactor, lost.pending, false, { lost: false, skip: lost.skip });
      expect(first.entries).toEqual([]);
      expect(first.skip).toBe(0);
      expect(first.dropped.lines).toBe(1);
      expect(first.dropped.bytes).toBe(Buffer.byteLength(JSON.stringify(muted)));
      expect(first.pending?.text).toBe(spelling.slice(0, middle));
      const result =
        boundary === "batch"
          ? redactOutput([continuation], redactor, OutputRedactionPendingSchema.parse(JSON.parse(JSON.stringify(first.pending))), false, {
              lost: false,
              skip: first.skip,
            })
          : redactOutput([muted, continuation], redactor, lost.pending, false, { lost: false, skip: lost.skip });
      expect(result.entries.flatMap((entry) => entry.text)).toEqual([
        { type: "secret", name: "TOKEN" },
        { type: "text", text: "!" },
      ]);
      expect(result.pending).toBeNull();
    });
  }
}

test("harden suppressed candidates through mismatch, finalization and repeated gaps", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const muted = redactOutput([line("ab")], redactor, null, false, { lost: false, skip: 1 });
  expect(muted.pending?.hidden).toBe(2);
  expect(redactOutput([line("x!")], redactor, muted.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "text", text: "x!" },
  ]);
  expect(redactOutput([], redactor, muted.pending, true).entries).toEqual([]);
  expect(redactOutput([], redactor, muted.pending, false, { lost: true, skip: 0 }).entries).toEqual([]);
  const lost = redactOutput([line(".".repeat(redactor.longest) + "ab")], redactor, null, false, { lost: true, skip: 0 });
  const next = redactOutput([line("cd")], redactor, lost.pending, false, { lost: false, skip: lost.skip });
  expect(next.pending?.text).toBe("abcd");
  expect(next.pending?.hidden).toBe(4);
  const last = redactOutput([line("efgh!")], redactor, next.pending, false, { lost: false, skip: next.skip });
  expect(last.entries).toEqual([]);
  expect(last.skip).toBe(0);
  expect(redactOutput([line("ordinary!")], redactor, last.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "text", text: "ordinary!" },
  ]);
});

for (const fragments of [
  ["abc", "defghi!"],
  ["ab", "c", "def", "ghi!"],
  ["abc", "x!"],
  ["abc", ""],
]) {
  test(`harden overlapping deferred areas across ${JSON.stringify(fragments)}`, () => {
    const redactor = compileOutputRedaction(
      new Map([
        ["abc", "[secret:FIRST]"],
        ["bcdefghi", "[secret:SECOND]"],
      ]),
    );
    let pending: OutputRedactionPending = null;
    const parts = [];
    for (const text of fragments) {
      const result = redactOutput([line(text)], redactor, pending);
      parts.push(...result.entries.flatMap((entry) => entry.text));
      pending = result.pending ? OutputRedactionPendingSchema.parse(JSON.parse(JSON.stringify(result.pending))) : null;
      if (pending) expect(pending.text.length).toBeLessThan(redactor.longest);
    }
    parts.push(...redactOutput([], redactor, pending, true).entries.flatMap((entry) => entry.text));
    expect(parts).toEqual([
      { type: "secret", name: "FIRST" },
      ...(fragments.at(-1) === "x!"
        ? [{ type: "text" as const, text: "x!" }]
        : fragments.at(-1)
          ? [{ type: "text" as const, text: "!" }]
          : []),
    ]);
  });
}

test("harden bounded deferred areas through repetitive overlapping input", () => {
  const redactor = compileOutputRedaction(new Map([["aaaaaaaa", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  for (let index = 0; index < 4; index++) {
    const result = redactOutput([line("a".repeat(1024))], redactor, pending);
    expect(result.entries.flatMap((entry) => entry.text)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([line("!")], redactor, pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "TOKEN" },
    { type: "text", text: "!" },
  ]);
});

test("ordinary output resumes after a preceding batch gap at a resolved boundary", () => {
  const redactor = compileOutputRedaction(
    secretEchoReplacements([{ name: "TOKEN", value: "private-token", sent: "Bearer private-token" }]),
  );
  const first = redactOutput([line("first private-token")], redactor);
  expect(first.pending).toBeNull();
  const last = { ...line("last"), at: "2030-01-02T00:00:01.000Z" };
  const result = redactOutput([last], redactor, first.pending, false, { lost: true, skip: 0, lossBeforeBatch: true });
  expect(result.entries).toEqual([{ ...last, text: [{ type: "text", text: "last" }] }]);
  expect(result.dropped).toEqual({ lines: 0, bytes: 0 });
  expect(result.pending).toBeNull();
  expect(result.skip).toBe(0);
});

for (const spelling of replacements.keys()) {
  test(`harden preceding-gap continuations for ${Buffer.from(spelling).toString("hex")}`, () => {
    const redactor = compileOutputRedaction(replacements);
    for (let cut = 1; cut < spelling.length; cut++) {
      const suffix = spelling.slice(cut);
      const result = redactOutput([line(suffix)], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: true });
      expect(result.entries).toEqual([]);
      expect(result.dropped.lines).toBe(1);
      // A partial continuation must also wait for the rest, even before it is a suffix.
      const partial = redactOutput([line(suffix.slice(0, 1))], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: true });
      expect(partial.entries).toEqual([]);
    }
  });
}

test("harden preceding-gap resumption with a deterministic linear comparison bound", () => {
  const spelling = "a".repeat(6000) + "b";
  const text = "a".repeat(10 * 1024) + "c";
  const redactor = compileOutputRedaction(new Map([[spelling, "[secret:TOKEN]"]]));
  let comparisons = 0;
  const original = String.prototype.charCodeAt;
  const lookup = spyOn(String.prototype, "charCodeAt").mockImplementation(function (this: string, index) {
    comparisons++;
    return original.call(this, index);
  });
  let result: ReturnType<typeof redactOutput>;
  let work: number;
  try {
    result = redactOutput([line(text)], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: true });
    work = comparisons;
  } finally {
    lookup.mockRestore();
  }
  // One unit read and one comparison per position; each fallback decreases the
  // matched length, so total charCodeAt calls are at most three per input unit.
  expect(work).toBeLessThanOrEqual(3 * (text.length + spelling.length));
  expect(result.entries.flatMap((entry) => entry.text)).toEqual([{ type: "text", text }]);
});

test("harden unresolved and internally incomplete batches when ordinary text follows", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const pending = redactOutput([line("abcd")], redactor).pending;
  const unresolved = redactOutput([line("last")], redactor, pending, false, { lost: true, skip: 0, lossBeforeBatch: true });
  expect(unresolved.entries.flatMap((entry) => entry.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
  expect(unresolved.dropped.lines).toBe(1);
  const internal = redactOutput([line("last")], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: false });
  expect(internal.entries).toEqual([]);
  expect(internal.dropped.lines).toBe(1);
});

test("harden preceding-gap continuations inside UTF-16 pairs", () => {
  const value = "abcd😀efgh";
  const redactor = compileOutputRedaction(new Map([[value, "[secret:TOKEN]"]]));
  for (let cut = 1; cut < value.length; cut++) {
    const suffix = value.slice(cut);
    const result = redactOutput([line(suffix)], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: true });
    expect(result.entries).toEqual([]);
    const partial = redactOutput([line(suffix.slice(0, 1))], redactor, null, false, { lost: true, skip: 0, lossBeforeBatch: true });
    expect(partial.entries).toEqual([]);
  }
});

for (const spelling of replacements.keys()) {
  test(`step text shares redaction across fields and bundles: ${Buffer.from(spelling).toString("hex")}`, async () => {
    const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
    const middle = Math.floor(spelling.length / 2);
    const step = {
      kind: "step" as const,
      id: 1,
      at: line("").at,
      status: "running" as const,
      startedAt: line("").at,
      label: "Read",
      description: spelling.slice(0, middle),
    };
    const redactor = compileOutputRedaction(replacements);
    const first = redactOutput(codeOutputFragments([step], 1), redactor);
    const visible = assembleCodeOutput(first.entries);
    expect(visible).toMatchObject([{ kind: "step", id: "1:step:1", label: [{ type: "text", text: "Read" }] }]);
    expect(first.pending?.step?.field).toBe("description");
    // Match the real encrypted JSON boundary: metadata aliases must survive as values.
    const pending = OutputRedactionPendingSchema.parse(JSON.parse(JSON.stringify(first.pending)));
    const second = redactOutput([line(spelling.slice(middle) + "!")], redactor, pending);
    const updated = assembleCodeOutput(second.entries);
    expect(updated[0]).toMatchObject({ kind: "step", id: "1:step:1", description: [{ type: "secret", name: "TOKEN" }] });
    expect(JSON.stringify([...visible, ...updated])).not.toContain(value);
    const terminal = redactOutput(
      codeOutputFragments(
        [
          {
            ...step,
            status: "failed",
            endedAt: line("").at,
            description: "",
            label: spelling.slice(0, middle),
            message: spelling.slice(middle),
          },
        ],
        1,
      ),
      redactor,
      null,
      true,
    );
    const sanitized = assembleCodeOutput(terminal.entries);
    expect(sanitized).toMatchObject([{ kind: "step", label: [{ type: "secret", name: "TOKEN" }] }]);
    expect(JSON.stringify(sanitized)).not.toContain(value);
  });
}

test("step fields are cleaned, final pending text updates the same ID, and icons remain identifiers", async () => {
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const raw = {
    kind: "step" as const,
    id: 1,
    at: line("").at,
    status: "failed" as const,
    endedAt: line("").at,
    label: "\x1b[31mRead\u202e",
    icon: "file-text",
    description: "\x00plain",
    message: "ab",
  };
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const first = redactOutput(codeOutputFragments([raw], 2), redactor);
  expect(assembleCodeOutput(first.entries)).toEqual([
    {
      kind: "step",
      id: "2:step:1",
      at: raw.at,
      status: "failed",
      endedAt: raw.at,
      label: [{ type: "text", text: "Read" }],
      icon: "file-text",
      description: [{ type: "text", text: "plain" }],
      message: [],
    },
  ]);
  const final = assembleCodeOutput(redactOutput([], redactor, first.pending, true).entries);
  expect(final).toMatchObject([{ kind: "step", id: "2:step:1", message: [{ type: "secret", name: "TOKEN" }] }]);
  const unsafe = assembleCodeOutput(
    redactOutput(codeOutputFragments([{ ...raw, icon: "abcdefgh", message: "" }], 2), redactor, null, true).entries,
  );
  expect(unsafe[0]).not.toHaveProperty("icon");
});

test("a pending step field keeps the continuous matcher across counted loss", async () => {
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const first = redactOutput(
    codeOutputFragments(
      [{ kind: "step", id: 1, at: line("").at, status: "failed", endedAt: line("").at, label: "Read", message: "abcd" }],
      1,
    ),
    redactor,
  );
  assembleCodeOutput(first.entries);
  const gap = redactOutput([line("efgh")], redactor, first.pending, false, { lost: true, skip: 0 });
  const entries = assembleCodeOutput(gap.entries);
  expect(entries[0]).toMatchObject({ kind: "step", id: "1:step:1", message: [{ type: "secret", name: "TOKEN" }] });
  expect(JSON.stringify(entries)).not.toContain("abcd");
  const next = redactOutput([line("ordinary text!")], redactor, gap.pending, false, { lost: false, skip: gap.skip });
  expect(JSON.stringify(assembleCodeOutput(next.entries))).not.toContain("abcd");
});

test("deferred step text settles its latest lifecycle revision", async () => {
  const { appendCodeOutput, emptyCodeOutput } = await import("@k2b/cloud/code");
  const { LIVE_LIMITS } = await import("@k2b/cloud/events/limits");
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const redactor = compileOutputRedaction(new Map([["aaa", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  let window = emptyCodeOutput(1);
  const at = line("").at;
  const steps: OutputSteps = {};
  for (const status of ["pending", "running", "succeeded"] as const) {
    const fragments = codeOutputFragments(
      [
        {
          kind: "step",
          id: 1,
          at,
          label: "a",
          status,
          ...(status === "pending" ? {} : { startedAt: at }),
          ...(status === "succeeded" ? { endedAt: at } : {}),
        },
      ],
      1,
      steps,
    );
    const result = redactOutput(fragments, redactor, bindOutputPending(pending, steps));
    window = appendCodeOutput(
      window,
      assembleCodeOutput(result.entries).map((entry) => ({ ...entry, id: "1:step:1" })),
      LIVE_LIMITS.frameBytes,
    );
    pending = result.pending ? OutputRedactionPendingSchema.parse(JSON.parse(JSON.stringify(result.pending))) : null;
  }
  // A delimiter resolves the single original "a" without synthesizing copies.
  const final = assembleCodeOutput(redactOutput([line("!")], redactor, bindOutputPending(pending, steps)).entries);
  window = appendCodeOutput(
    window,
    final.map((entry) => ({ ...entry, id: "1:step:1" })),
    LIVE_LIMITS.frameBytes,
  );
  expect(window.entries[0]).toMatchObject({ kind: "step", id: "1:step:1", at, status: "succeeded", label: [{ type: "text", text: "a" }] });
  expect(JSON.stringify(window)).not.toContain('"type":"secret"');
});

test("suppressed fields count as one lost step revision", async () => {
  const { codeOutputFragments } = await import("./output-redaction");
  const result = redactOutput(
    codeOutputFragments(
      [
        {
          kind: "step",
          id: 1,
          at: line("").at,
          label: "Read",
          description: "Document",
          message: "Reason",
          status: "running",
          startedAt: line("").at,
        },
      ],
      1,
    ),
    compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]])),
    null,
    false,
    { lost: true, skip: 0 },
  );
  expect(result.dropped.lines).toBe(1);
});

test("step metadata is admitted once across revisions and terminal entries are immutable", async () => {
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const steps: OutputSteps = {};
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const at = line("").at;
  const base = { kind: "step" as const, id: 1, at, label: "gh", status: "pending" as const };
  const first = redactOutput(codeOutputFragments([line("abcdef"), base], 1, steps), redactor);
  const visible = assembleCodeOutput(first.entries);
  const revision = codeOutputFragments([{ ...base, label: "CHANGED", status: "running", startedAt: at }], 1, steps);
  expect(revision.map((fragment) => fragment.text)).toEqual([""]);
  assembleCodeOutput(redactOutput(revision, redactor, bindOutputPending(first.pending, steps)).entries);
  expect(JSON.stringify(steps)).not.toContain("gh");
  expect(JSON.stringify(visible)).toContain('"type":"secret"');
  assembleCodeOutput(
    redactOutput(codeOutputFragments([{ ...base, status: "succeeded", startedAt: at, endedAt: at, message: "Done" }], 1, steps), redactor)
      .entries,
  );
  const saved = JSON.stringify(steps);
  expect(codeOutputFragments([{ ...base, label: "Rewritten", status: "failed", endedAt: at, message: "Changed" }], 1, steps)).toEqual([]);
  expect(JSON.stringify(steps)).toBe(saved);
});

test("loss during completion preserves previously accepted metadata and monotone lifecycle", async () => {
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const steps: OutputSteps = {};
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const at = line("").at;
  const base = { kind: "step" as const, id: 1, at, label: "Read", status: "pending" as const };
  assembleCodeOutput(redactOutput(codeOutputFragments([base, { ...base, status: "running", startedAt: at }], 1, steps), redactor).entries);
  const complete = codeOutputFragments([{ ...base, status: "succeeded", startedAt: at, endedAt: at, message: "Done" }], 1, steps);
  assembleCodeOutput(redactOutput(complete, redactor, null, false, { lost: true, skip: 0 }).entries);
  expect(steps["1:step:1"]).toMatchObject({ status: "succeeded", label: [{ type: "text", text: "Read" }], message: [] });
  const other: OutputSteps = {};
  codeOutputFragments([base], 1, other);
  expect(codeOutputFragments([{ ...base, status: "running", startedAt: "2029-01-01T00:00:00.000Z" }], 1, other)).toEqual([]);
  expect(codeOutputFragments([{ ...base, status: "failed", endedAt: at }], 1, other)).toHaveLength(1);
  expect(other["1:step:1"]).not.toHaveProperty("startedAt");
});

test("canonical step metadata stays within its shared budget without displacing earlier text", async () => {
  const { codeOutputFragments, assembleCodeOutput } = await import("./output-redaction");
  const steps: OutputSteps = {};
  const dropped = { lines: 0, bytes: 0 };
  const budget = 1024;
  const base = { kind: "step" as const, id: 1, at: line("").at, label: "Read", status: "pending" as const };
  const redactor = compileOutputRedaction(new Map());
  assembleCodeOutput(redactOutput(codeOutputFragments([base], 1, steps, budget), redactor).entries, { steps, budget, dropped });
  const next = { ...base, id: 2, label: "x".repeat(1000), description: "y".repeat(1000) };
  assembleCodeOutput(redactOutput(codeOutputFragments([next], 1, steps, budget), redactor).entries, { steps, budget, dropped });
  expect(Buffer.byteLength(JSON.stringify(steps))).toBeLessThanOrEqual(budget);
  expect(steps["1:step:1"]?.label).toEqual([{ type: "text", text: "Read" }]);
  expect(dropped.lines).toBeGreaterThan(0);
  expect(dropped.bytes).toBeGreaterThan(0);
});

test("step lifecycle timestamp spellings use the same bounded precision as the host", async () => {
  const { codeOutputFragments } = await import("./output-redaction");
  const steps: OutputSteps = {};
  const at = line("").at;
  const base = { kind: "step" as const, id: 1, at, label: "Read", status: "pending" as const };
  codeOutputFragments([base], 1, steps);
  const extended = `2030-01-02T00:00:00.${"0".repeat(1000)}Z`;
  codeOutputFragments([{ ...base, status: "running", startedAt: extended }], 1, steps);
  expect(steps["1:step:1"]).toMatchObject({ status: "running", startedAt: at });
  codeOutputFragments([{ ...base, status: "succeeded", startedAt: extended, endedAt: extended }], 1, steps);
  expect(steps["1:step:1"]).toMatchObject({ status: "succeeded", startedAt: at, endedAt: at });
});
