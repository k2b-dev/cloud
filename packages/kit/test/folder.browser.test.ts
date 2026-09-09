import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";

test("native folder files retain their relative paths across the worker transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kit-folder-"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "input.csv"), "a;b");
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.setContent('<input type="file" webkitdirectory multiple>');
    await page.locator("input").setInputFiles(directory);
    const result = await page.locator("input").evaluate((input: HTMLInputElement) => {
      const file = input.files![0]!;
      const clone = structuredClone(file);
      return {
        before: file.webkitRelativePath,
        after: clone.webkitRelativePath,
      };
    });
    expect(result.before).toContain("/nested/input.csv");
    expect(result.after).toBe(result.before);
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
