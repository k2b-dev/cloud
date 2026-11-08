import { expect, test } from "bun:test";
import { basename, resolve } from "node:path";
import { panelIslandEntries } from "./help-panel";
import { islandBundleSize } from "./island-bundle-size";
import { buildIslandClosure } from "./island-closure";

// The /panel islands reach @k2b/ssr's mount runtime through @k2b/ui's Button and @k2b/ssr/nav, but use none of its
// code: a change there is dead code for this closure, the case that moved the measured size by tens of bytes (#2875).
const mount = resolve(import.meta.dir, "../../packages/ssr/src/mount.ts");
const source = await Bun.file(mount).text();
// Two different unused additions: whether one of them renames anything depends on the code around it (a probe like
// code already in mount.ts changes nothing), so the test needs only one of them to change the unmeasured build.
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
const eagerText = async (files?: Record<string, string>) => {
  const build = await buildIslandClosure(panelIslandEntries, files);
  const outputs = await Promise.all(build.outputs.map(async (output) => `${basename(output.path)}\n${await output.text()}`));
  return outputs.sort().join("\n");
};

test("unused code that only renames the minifier's choices or the chunk hashes does not change the measured size", async () => {
  // The unmeasured build really differs for at least one of them: other names in the shared chunks, other chunk
  // hashes, or both.
  const plain = await eagerText();
  const differs = await Promise.all(deadChanges.map(async (code) => (await eagerText({ [mount]: code })) !== plain));
  expect(differs).toContain(true);
  const base = await islandBundleSize(panelIslandEntries);
  for (const code of deadChanges) {
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
