import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkMotionSource, formatBaseline, rule } from "./motion";

const file = "packages/ui/src/styles/sample.css";
const baseline = "scripts/checks/motion.baseline";
const check = (source: string) =>
  checkMotionSource(file, source).map(({ line, key }) => `${line} ${key.split(" | ").slice(1).join(" | ")}`);

test("finds layout transitions and nested keyframe declarations at their starting line", () => {
  expect(
    check(`/* transition: height 1s;\n comment */
@media (width > 1px) {
  .sample {
    transition:
      width 200ms ease-out,
      opacity .2s linear;
    transition-property: height, transform, all, padding-inline;
  }
  @keyframes grow {
    from { min-block-size: 0; opacity: 0; }
    50% { inset-inline-start: 1px; }
    to { min-block-size: 1rem; }
  }
}`),
  ).toEqual([
    "5 layout | width",
    "5 literal | 200ms",
    "5 literal | ease-out",
    "5 literal | .2s",
    "5 literal | linear",
    "8 layout | height",
    "8 layout | all",
    "8 layout | padding-inline",
    "11 layout | @keyframes grow min-block-size",
    "12 layout | @keyframes grow inset-inline-start",
    "13 layout | @keyframes grow min-block-size",
  ]);
});

test("finds a shorthand property after its time and curve", () => {
  expect(check(".sample { transition: 0s var(--k2b-ease-out) width; }")).toEqual(["1 layout | width"]);
});

test("normalizes transition property names before checking layout", () => {
  expect(check(".sample { transition: HEIGHT 1s; transition-property: WIDTH, ALL, Opacity; }")).toEqual([
    "1 layout | height",
    "1 literal | 1s",
    "1 layout | width",
    "1 layout | all",
  ]);
});

test("shorthand entries without a property name default to all", () => {
  expect(check(".sample { transition: var(--k2b-motion-base) var(--k2b-ease-out); }")).toEqual(["1 layout | all"]);
  expect(check(".sample { transition: opacity var(--duration), 0s ease allow-discrete, var(--duration) NORMAL; }")).toEqual([
    "1 layout | all",
    "1 layout | all",
    "1 literal | ease",
  ]);
  for (const value of ["1s", "-150ms .2s", "cubic-bezier(.2, 0, 1, 1)", "steps(2, end)", "linear(0, 1)", "allow-discrete", "normal"]) {
    const implicit = checkMotionSource(file, `.sample { transition: ${value}; }`).filter(({ kind }) => kind === "layout");
    const explicit = checkMotionSource(file, ".sample { transition: all; }");
    expect(implicit).toEqual(explicit);
  }
});

test("does not infer all for named properties, whole-value keywords, empty values, or transition-property", () => {
  for (const value of ["", "none", "inherit", "initial", "unset", "revert", "revert-layer", "NONE", "opacity var(--k2b-motion-base)"]) {
    expect(check(`.sample { transition: ${value}; }`)).toEqual([]);
  }
  expect(check(".sample { transition-property: var(--duration), 0s, ease, normal, allow-discrete; }")).toEqual([]);
  // A time inside another token is not a whole time token and cannot imply all.
  expect(check(".sample { transition: calc(1s + var(--extra)); }")).toEqual(["1 literal | 1s"]);
});

test("preserves comment markers in quoted CSS strings, including escaped quotes and backslashes", () => {
  for (const content of [String.raw`"/*"`, String.raw`'/*'`, String.raw`"\"/*"`, String.raw`'\'/*'`, String.raw`"\\"`, String.raw`'\\'`]) {
    expect(check(`.sample { content: ${content}; /* transition: height 1s; */ transition: width 1s; }`)).toEqual([
      "1 layout | width",
      "1 literal | 1s",
    ]);
  }
});

test("blanks real comments while preserving declaration line numbers after quoted markers", () => {
  expect(
    check(`.sample { content: "/*"; /* transition: height 1s;
  comment */
  transition: /* duration
  comment */ width 1s;
}`),
  ).toEqual(["3 layout | width", "3 literal | 1s"]);
});

test("recognizes layout sizes, spacing, and position but leaves painted properties alone", () => {
  const properties = [
    "width",
    "height",
    "min-width",
    "max-height",
    "inline-size",
    "max-block-size",
    "padding",
    "padding-top",
    "margin",
    "margin-inline",
    "top",
    "right",
    "bottom",
    "left",
    "inset",
    "inset-block",
  ];
  expect(
    checkMotionSource(file, `.sample { transition-property: ${properties.join(",")}, transform, opacity, color, box-shadow; }`).map(
      ({ key }) => key,
    ),
  ).toEqual(properties.map((property) => `${file} | layout | ${property}`));
});

test("recognizes nonzero times and complete easing tokens, not animation or property names", () => {
  expect(
    check(`.sample {
  animation: k2b-spin 900ms linear infinite, ease-icon 1s steps(2, end);
  transition: linear-gradient-color 150ms cubic-bezier(0.23,\n    1, 0.32, 1);
  transition-timing-function: ease, ease-in, ease-out, ease-in-out, step-start, step-end, linear(0, .5, 1);
}`),
  ).toEqual([
    "2 literal | 900ms",
    "2 literal | linear",
    "2 literal | 1s",
    "2 literal | steps(2, end)",
    "3 literal | 150ms",
    "3 literal | cubic-bezier(0.23, 1, 0.32, 1)",
    "5 literal | ease",
    "5 literal | ease-in",
    "5 literal | ease-out",
    "5 literal | ease-in-out",
    "5 literal | step-start",
    "5 literal | step-end",
    "5 literal | linear(0, .5, 1)",
  ]);
});

test("finds times inside calculations and separate duration and delay declarations", () => {
  expect(
    check(`.sample {
  transition-duration: calc(1s + var(--extra, 2s));
  transition-delay: -150ms;
  animation-duration: .2s;
  animation-delay: 0ms;
  animation-timing-function: ease-out;
  animation: "linear" 0ms;
}`),
  ).toEqual(["2 literal | 1s", "3 literal | -150ms", "4 literal | .2s", "6 literal | ease-out"]);
});

test("ignores tokens with nested fallbacks, zero, none, definitions, and comments", () => {
  expect(
    check(`.sample {
  --k2b-motion-fast: 120ms;
  --k2b-ease-out: cubic-bezier(.23, 1, .32, 1);
  transition: opacity var(--k2b-motion-fast, var(--duration, 150ms)) var(--k2b-ease-out, ease);
  transition-duration: 0s, 0ms, 0.0s;
  animation: none;
  animation-name: ease-in;
  color: red; /* animation: wrong 1s ease; */
}`),
  ).toEqual([]);
});

test("finds layout utilities in @apply after variants and important markers", () => {
  for (const utility of ["transition-all", "hover:md:!transition-all", "[&:hover]:transition-all!", "![&:hover]:transition-all"]) {
    expect(check(`.sample { @apply ${utility}; }`)).toEqual(["1 layout | all"]);
  }
  expect(check(".sample { @apply transition-[height,opacity] transition-[max-height]; }")).toEqual([
    "1 layout | height",
    "1 layout | max-height",
  ]);
  expect(check(".sample { @apply transition-[HEIGHT_width,opacity,ALL] }")).toEqual(["1 layout | height", "1 layout | all"]);
});

test("ignores painted transitions and other utilities in @apply", () => {
  expect(check(".sample { @apply transition-[opacity,transform] transition-colors transition-opacity transition animate-spin; }")).toEqual(
    [],
  );
});

test("finds time and easing literals in @apply", () => {
  expect(check(".sample { @apply duration-200 delay-75 ease-out; }")).toEqual([
    "1 literal | 200ms",
    "1 literal | 75ms",
    "1 literal | ease-out",
  ]);
  expect(check(".sample { @apply [&:hover]:!duration-[1.5s] delay-[calc(0s_+_75ms_+_var(--extra,2s))]; }")).toEqual([
    "1 literal | 1.5s",
    "1 literal | 75ms",
  ]);
  expect(check(".sample { @apply ease-linear ease-in ease-in-out ease-[cubic-bezier(.2,_0,_1,_1)]; }")).toEqual([
    "1 literal | ease-linear",
    "1 literal | ease-in",
    "1 literal | ease-in-out",
    "1 literal | cubic-bezier(.2, 0, 1, 1)",
  ]);
});

test("ignores zero times and motion token references in @apply", () => {
  expect(
    check(`.sample { @apply duration-0 delay-0 duration-[0s] delay-[0ms]
      duration-(--k2b-motion-base) duration-[var(--k2b-motion-base)] delay-[var(--delay,1s)]
      duration-[--k2b-motion-base] ease-(--k2b-ease-out) ease-[var(--k2b-ease-out)]; }`),
  ).toEqual([]);
});

test("reports the starting line of @apply after leading whitespace", () => {
  expect(check(".sample {\n\n  @apply\n    transition-all duration-200\n}")).toEqual(["3 layout | all", "3 literal | 200ms"]);
});

const workspace = async (source: string, keys?: string[]) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-motion-"));
  const files: Record<string, string> = { [file]: source, "packages/demo/src/application.css": ".app { transition: all 1s ease; }" };
  if (keys) files[baseline] = formatBaseline(keys);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const run = async (fix = false, flags = new Set<string>()) =>
    (await rule.run({ workspaceRoot: root, fix, flags })).map(
      (finding) => `${relative(root, finding.file ?? "")}${finding.line ? `:${finding.line}` : ""}`,
    );
  return { root, run };
};

test("new layout transitions and keyframes fail while new literals only warn", async () => {
  const { root, run } = await workspace(".sample { transition: width 150ms ease; }\n@keyframes grow { to { height: 1px; } }");
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await run()).toEqual([`${file}:1`, `${file}:2`]);
    expect(warnings.mock.calls.map(([warning]) => warning)).toEqual([
      `warn  motion: ${file}:1 Use the motion tokens (--k2b-motion-*, --k2b-ease-*) instead of 150ms.`,
      `warn  motion: ${file}:1 Use the motion tokens (--k2b-motion-*, --k2b-ease-*) instead of ease.`,
    ]);
    await writeFile(join(root, file), ".sample { transition: opacity 150ms ease; }");
    expect(await run()).toEqual([]);
  } finally {
    warnings.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("counts each file and key separately and only removes stale baseline occurrences", async () => {
  const source = ".sample { transition: width 150ms ease; }";
  const keys = checkMotionSource(file, source).map(({ key }) => key);
  const { root, run } = await workspace(source, keys);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await run()).toEqual([]);
    await run(false, new Set(["--warnings"]));
    expect(warnings.mock.calls.some(([warning]) => String(warning).includes(`${file}:1`))).toBe(true);
    warnings.mockClear();
    await writeFile(join(root, file), `${source}\n${source}`);
    expect(await run()).toEqual([`${file}:2`]);
    expect(warnings.mock.calls.filter(([warning]) => String(warning).startsWith(`warn  motion: ${file}:2`))).toHaveLength(2);

    // Another file cannot consume this file's allowance.
    const other = "packages/ui/src/nested/other.css";
    await mkdir(dirname(join(root, other)), { recursive: true });
    await writeFile(join(root, other), source);
    expect(await run()).toEqual([`${other}:1`, `${file}:2`]);
    await rm(join(root, other));

    await writeFile(join(root, file), ".sample { transition: opacity 150ms var(--k2b-ease-out); animation: new-spin 2s linear; }");
    expect(await run()).toEqual([baseline, baseline]);
    expect(await run(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([`${file} | literal | 150ms`]));
    expect(await run(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([`${file} | literal | 150ms`]));
  } finally {
    warnings.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("fix removes only the missing occurrence of a repeated key", async () => {
  const key = `${file} | layout | width`;
  const { root, run } = await workspace(".sample { transition-property: width; }", [key, key]);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await run()).toEqual([baseline]);
    expect(await run(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([key]));
  } finally {
    warnings.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
