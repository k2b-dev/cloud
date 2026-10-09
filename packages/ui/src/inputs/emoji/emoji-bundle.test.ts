import { expect, test } from "bun:test";
import { resolve } from "node:path";

// An application bundles the picker and the composer like any island: with code splitting. The emoji data must stay in
// a chunk of its own that loads on first use, so a page that never opens the picker does not grow by it.
test("keeps the emoji data out of the bundle until the picker or a shortcode needs it", async () => {
  const ui = resolve(import.meta.dir, "../../..");
  const entry = resolve(import.meta.dir, "emoji-bundle.fixture.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: {
      [entry]: `import { Chat, EmojiPicker, rememberEmoji } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
console.log(Chat, EmojiPicker, rememberEmoji);`,
    },
    target: "browser",
    conditions: ["browser"],
    format: "esm",
    splitting: true,
    minify: true,
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the emoji fixture.");

  const outputs = await Promise.all(build.outputs.map(async (output) => ({ kind: output.kind, text: await output.text() })));
  const sample = "grinning face with big eyes";
  const page = outputs.find((output) => output.kind === "entry-point")!;
  const data = outputs.filter((output) => output.text.includes(sample));
  expect(page.text).not.toContain(sample);
  expect(data).toHaveLength(1);
  expect(data[0]!.kind).toBe("chunk");
  // The page refers to the data only through a dynamic import.
  expect(page.text).toMatch(/import\(\s*["'][^"']+["']\s*\)/);
});
