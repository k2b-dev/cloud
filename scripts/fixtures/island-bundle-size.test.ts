import { expect, test } from "bun:test";
import { basename, resolve } from "node:path";
import { panelIslandEntries } from "./help-panel";
import { islandBundleSize } from "./island-bundle-size";
import { buildIslandClosure } from "./island-closure";

// The /panel islands reach @k2b/ssr's mount runtime through @k2b/ui's Button and @k2b/ssr/nav, but use none of its
// code: a change there is dead code for this closure, the case that moved the measured size by tens of bytes (#2875).
const mount = resolve(import.meta.dir, "../../packages/ssr/src/mount.ts");
const source = await Bun.file(mount).text();
// Two different unused additions, the shapes that moved the size in #2875; the measured size stays the same for both.
const deadChanges = [
  `${source}
export const unusedProbe = (element: HTMLElement) => {
  const all = element.getElementsByTagName("*");
  const focused = [...all].indexOf(document.activeElement!);
  const node = all[focused];
  if (node instanceof HTMLElement) node.focus();
  return render(() => createComponent(ErrorBoundary, { fallback: () => null, children: null }), element);
};
`,
  `${source}
export const unusedProbe = (element: HTMLElement) => {
${Array.from({ length: 30 }, (_, index) => `  const child${index} = element.children[${index}];`).join("\n")}
  return [${Array.from({ length: 30 }, (_, index) => `child${index}`).join(", ")}, render(() => createComponent(ErrorBoundary, { fallback: () => null, children: null }), element)];
};
`,
];
// Whether one of them renames anything depends on the code around it and on the dependency versions, so the test does
// not rely on them: one more unused function uses the module's imports twice as often each round until the unmeasured
// build differs. The minifier names by use count, so enough uses always shift its choices; the function's single name
// stays the same in every round.
const deadRun = (count: number) => `${source}
export const unusedRun = (element: HTMLElement) => [
${Array.from(
  { length: count },
  (_, index) =>
    `  render(() => createComponent(ErrorBoundary, { fallback: () => fromJSON(${index}), children: getOwner() }), element.children[${index}]!),`,
).join("\n")}
];
`;
const RUN_LIMIT = 256;
const eagerText = async (files?: Record<string, string>) => {
  const build = await buildIslandClosure(panelIslandEntries, files);
  const outputs = await Promise.all(build.outputs.map(async (output) => `${basename(output.path)}\n${await output.text()}`));
  return outputs.sort().join("\n");
};

test("unused code that only renames the minifier's choices or the chunk hashes does not change the measured size", async () => {
  // The unmeasured build really differs for the change the run finds: other names in the shared chunks, other chunk
  // hashes, or both. The search ends at a fixed size, so a build that no unused code can move fails here, loudly.
  const plain = await eagerText();
  let renaming: string | undefined;
  for (let count = 1; count <= RUN_LIMIT && renaming === undefined; count *= 2) {
    const code = deadRun(count);
    if ((await eagerText({ [mount]: code })) !== plain) renaming = code;
  }
  expect(renaming).toBeDefined();
  const base = await islandBundleSize(panelIslandEntries);
  for (const code of [...deadChanges, renaming!]) {
    const changed = await islandBundleSize(panelIslandEntries, { [mount]: code });
    expect(changed.eagerBrotliBytes).toBe(base.eagerBrotliBytes);
    expect(changed.eagerInputs).toEqual(base.eagerInputs);
  }
}, 300_000);

test("a real change of N compressed bytes stays visible as about N bytes", async () => {
  // About 1,000 bytes that Brotli cannot shrink: 2,000 hex digits of a fixed hash chain, used by the island at load.
  let digits = "";
  for (let seed = "panel"; digits.length < 2000; ) {
    seed = new Bun.CryptoHasher("sha256").update(seed).digest("hex");
    digits += seed;
  }
  const island = panelIslandEntries[0]!;
  const live = `${await Bun.file(island).text()}\n(globalThis as { panelProbe?: string }).panelProbe = ${JSON.stringify(digits.slice(0, 2000))};\n`;
  const base = await islandBundleSize(panelIslandEntries);
  const grown = await islandBundleSize(panelIslandEntries, { [island]: live });
  const delta = grown.eagerBrotliBytes - base.eagerBrotliBytes;
  expect(delta).toBeGreaterThanOrEqual(1000);
  expect(delta).toBeLessThanOrEqual(1060);
}, 300_000);
