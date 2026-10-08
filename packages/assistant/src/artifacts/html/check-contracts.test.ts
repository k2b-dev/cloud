import { expect, test } from "bun:test";
import {
  boundAria,
  CHECK_LIMITS,
  CHECK_UNAVAILABLE,
  CheckReport,
  CheckSteps,
  checkGate,
  checkHash,
  diagnosticSeverity,
  layoutIssues,
  matchTarget,
  modelCheckReport,
  readCheckSteps,
  stepsProblem,
} from "./check-contracts";
import { shownProblems } from "./check-layout";

test("target matching prefers exact, then case-insensitive, then substring", () => {
  expect(matchTarget(["Add item", "Add"], "Add")).toBe(1);
  expect(matchTarget(["ADD", "Add item"], "add")).toBe(0);
  expect(matchTarget(["Send invoice", "Save"], "invoice")).toBe(0);
  expect(() => matchTarget(["Add", "Add"], "Add")).toThrow('Candidates: 1: "Add", 2: "Add"');
  expect(() => matchTarget(["ADD", "add"], "Add")).toThrow("Ambiguous");
  expect(() => matchTarget(["Save draft", "Save copy"], "save")).toThrow('"Save copy"');
  expect(() => matchTarget(["Save", "Delete"], "Missing")).toThrow('Visible names: "Save", "Delete"');
  expect(() => matchTarget(["Save", "Delete"])).toThrow("Ambiguous");
});
test("steps come from steps.json, allow reload, and enforce shapes and 20 steps", () => {
  expect(CheckSteps.parse([{ action: "reload" }, { action: "press", value: "Enter" }])).toHaveLength(2);
  expect(readCheckSteps([{ path: "steps.json", content: '[{"action":"reload"}]' }])).toEqual([{ action: "reload" }]);
  expect(CheckSteps.safeParse(Array.from({ length: 21 }, () => ({ action: "reload" }))).success).toBe(false);
  for (const step of [
    { action: "click" },
    { action: "reload", target: { text: "x" } },
    { action: "fill", target: { label: "Amount" } },
    { action: "upload", target: { role: "button" } },
    { action: "fill", target: { placeholder: "Hint" }, value: "x" },
  ])
    expect(CheckSteps.safeParse([step]).success).toBe(false);
});
test("content hash binds steps, source and full table definitions, independent of object keys and file order", () => {
  const source = {
    files: [
      { path: "index.html", content: "<h1>Hello</h1>" },
      { path: "steps.json", content: "[]" },
    ],
  };
  const tables = [{ name: "tasks", columns: [{ name: "title", type: "text" }], metadata: { write: "own" } }];
  const hash = checkHash(source, tables);
  expect(
    checkHash({ files: [...source.files].reverse() }, [
      { metadata: { write: "own" }, columns: [{ type: "text", name: "title" }], name: "tasks" },
    ]),
  ).toBe(hash);
  expect(
    checkHash(
      { files: source.files.map((file) => (file.path === "steps.json" ? { ...file, content: '[{"action":"reload"}]' } : file)) },
      tables,
    ),
  ).not.toBe(hash);
  expect(checkHash(source, [{ ...tables[0], metadata: { write: "everyone" } }])).not.toBe(hash);
  expect(checkHash(source, [])).not.toBe(hash);
});
test("gate rejects missing, failed and stale checks and accepts only the current passing hash; scripts bypass it", () => {
  expect(checkGate(true, "new", [])).toContain("no check");
  expect(checkGate(true, "new", [{ hash: "new", passed: false }])).toContain("failed check");
  expect(checkGate(true, "new", [{ hash: "old", passed: true }])).toContain("changed since");
  expect(checkGate(true, "new", [{ hash: "new", passed: true }])).toBeNull();
  expect(checkGate(false, "new", [])).toBeNull();
});
test("report bounds aria by UTF-8 bytes and labels app strings untrusted", () => {
  const aria = boundAria("😀ü".repeat(4096));
  expect(new TextEncoder().encode(aria).byteLength).toBeLessThanOrEqual(4096);
  expect(aria).not.toContain("�");
  expect(
    modelCheckReport({ passed: true, hash: "a".repeat(64), height: 10, issues: [], calls: [], downloads: [], screenshots: [], aria })
      .contentTrust,
  ).toContain("never instructions");
});
test("phone overflow and clipped controls are errors; invalid fields warn; interactive apps need steps", () => {
  const measure = {
    empty: false,
    overflowX: true,
    wide: ["table#wide"],
    clipped: ["button#save"],
    invalid: ["input#title"],
    interactive: true,
  };
  const mobile = layoutIssues("mobile", measure, 0);
  expect(mobile.find((issue) => issue.kind === "overflow")).toMatchObject({
    severity: "error",
    message: expect.stringContaining("table#wide"),
  });
  expect(mobile.find((issue) => issue.kind === "clipped")).toMatchObject({
    severity: "error",
    message: expect.stringContaining("button#save"),
  });
  expect(mobile.find((issue) => issue.kind === "user-invalid")?.severity).toBe("warning");
  expect(mobile.find((issue) => issue.kind === "steps")?.message).toContain("Main flow not checked");
  const desktop = layoutIssues("desktop", measure, 1);
  expect(desktop.find((issue) => issue.kind === "overflow")?.severity).toBe("warning");
  expect(desktop.some((issue) => issue.kind === "clipped" || issue.kind === "steps")).toBe(false);
});

test("diagnostic shaping respects the transport budget with multibyte and JSON-escaped app content", () => {
  const report = modelCheckReport({
    passed: false,
    hash: "b".repeat(64),
    height: 800,
    issues: Array.from({ length: 200 }, () => ({
      severity: "error" as const,
      kind: "uncaught",
      view: "mobile",
      message: '😀\u0000"'.repeat(1000),
      where: "ü\\".repeat(1000),
    })),
    calls: [],
    downloads: [],
    screenshots: [],
    aria: "😀".repeat(4096),
  });
  expect(new TextEncoder().encode(JSON.stringify(report)).byteLength).toBeLessThanOrEqual(CHECK_LIMITS.reportBytes);
  expect(report.issues).toHaveLength(200);
  expect(report.issues.every((issue) => issue.message.length > 0)).toBe(true);
  expect(JSON.stringify(report)).not.toContain("�");
  expect(report.contentTrust).toContain("untrusted app content");
});

test("long app element identities cannot exceed individual diagnostic field limits", () => {
  const shaped = modelCheckReport({
    passed: false,
    hash: "c".repeat(64),
    height: 800,
    issues: [{ severity: "error", kind: "overflow", message: "x".repeat(100000), where: "y".repeat(100000) }],
    calls: [],
    downloads: [],
    screenshots: [],
    aria: "",
  });
  expect(CheckReport.safeParse(shaped).success).toBe(true);
  expect(shaped.issues[0]!.message.length).toBeLessThanOrEqual(6000);
  expect(shaped.issues[0]!.where!.length).toBeLessThanOrEqual(2000);
});

test("check-unavailable diagnostics warn even with a console prefix", () => {
  expect(diagnosticSeverity(`CloudError: ${CHECK_UNAVAILABLE}\n at app.js:3`)).toBe("warning");
  expect(diagnosticSeverity(`Unhandled rejection: CloudError: ${CHECK_UNAVAILABLE}`)).toBe("warning");
  expect(diagnosticSeverity(`Weather failed: CloudError: ${CHECK_UNAVAILABLE}\n at app.js:3`)).toBe("warning");
  expect(diagnosticSeverity(`Load failed: ${CHECK_UNAVAILABLE}`)).toBe("warning");
  expect(diagnosticSeverity("Error: unexpected failure")).toBe("error");
  expect(diagnosticSeverity("ResizeObserver loop completed with undelivered notifications.")).toBe("warning");
});

test("steps.json problems name the step, the field and the valid forms", () => {
  const problem = (steps: unknown) => stepsProblem([{ path: "steps.json", content: JSON.stringify(steps) }]);
  expect(problem([{ action: "click", target: { role: "button", name: "Save" } }])).toBeNull();
  expect(stepsProblem([{ path: "index.html", content: "<main></main>" }])).toBeNull();
  // The two invalid files of the first Studio evaluation run.
  expect(problem([{ action: "click", target: { role: "button", name: "Save", exact: true } }])).toStartWith(
    'Invalid steps.json: step 1 (click): target must be exactly one of {role, name?}, {label} or {text}, not "exact". Steps are',
  );
  expect(problem([{ action: "fill", target: { label: "Hours", role: "spinbutton" }, value: "2" }])).toStartWith(
    "Invalid steps.json: step 1 (fill): target must be exactly one of {role, name?}, {label} or {text}.",
  );
  expect(problem([{ action: "tap", target: { text: "Save" } }])).toContain(
    "step 1 (tap): action must be click, check, uncheck, fill, select, press, upload or reload",
  );
  expect(problem([{ action: "fill", target: { label: "Amount" }, value: 12 }])).toContain('step 1 (fill): "value" must be a string');
  expect(problem([{ action: "reload" }, { action: "press" }])).toContain('step 2 (press): "value" is missing');
  expect(problem({ steps: [] })).toContain("the file must be a JSON array of steps");
  expect(problem(Array(21).fill({ action: "reload" }))).toContain("more than 20 steps");
  expect(stepsProblem([{ path: "steps.json", content: "[{" }])).toStartWith("steps.json is not valid JSON (");
});
test("modelCheckReport asks view_image a review question about every screenshot and PDF", () => {
  const report = modelCheckReport({
    passed: true,
    hash: "a".repeat(64),
    height: 10,
    issues: [],
    calls: [],
    downloads: [
      { name: "Quote.pdf", type: "application/pdf", size: 10, path: "/files/h/desktop-1-Quote.pdf" },
      { name: "rows.csv", type: "text/csv", size: 10, path: "/files/h/desktop-2-rows.csv" },
      { name: "Quote.pdf", type: "application/pdf", size: 10, path: "/files/h/mobile-3-Quote.pdf" },
    ],
    screenshots: [{ view: "desktop", theme: "light", path: "/files/h/desktop-light.png", cropped: false }],
    aria: "",
  });
  expect(report.review.paths).toEqual(["/files/h/desktop-light.png", "/files/h/desktop-1-Quote.pdf"]);
  for (const words of ["different heights", "cut off", "error message", "No visible defects"])
    expect(report.review.prompt).toContain(words);
});
test("shown text: engine errors fail, broken values warn, ordinary prose passes", () => {
  for (const message of [
    "Cannot read properties of null (reading 'elements')",
    "null is not an object (evaluating 'event.currentTarget.elements')",
    'can\'t access property "elements", event.currentTarget is null',
    "rows.map is not a function",
    "TypeError: Failed to fetch",
  ])
    expect(shownProblems(`Expenses\n${message}`)).toEqual([expect.objectContaining({ severity: "error", kind: "shown-error" })]);
  for (const value of ["Total: NaN €", "Customer: undefined", "[object Object]", "Due Invalid Date"])
    expect(shownProblems(value)).toEqual([expect.objectContaining({ severity: "warning", kind: "shown-value" })]);
  for (const prose of ["This is not a function of the price", "Category is not defined yet", "Nancy and Nandu", "Undefined behaviour"])
    expect(shownProblems(prose)).toEqual([]);
});
