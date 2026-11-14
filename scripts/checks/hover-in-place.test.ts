import { expect, test } from "bun:test";
import { checkHoverInPlaceSource } from "./hover-in-place";

const lines = (source: string) => checkHoverInPlaceSource("demo.browser.test.ts", source).map((finding) => finding.line);

test("reports a hover between two geometry reads of one flow", () => {
  expect(
    lines(`test("t", async () => {
  const before = await sample.boundingBox();
  await band.hover({ position: { x: 3, y: 3 } });
  expect(await sample.boundingBox()).toEqual(before);
});`),
  ).toEqual([3]);
});

test("counts page callbacks that read boxes or hit-test points, and page.hover", () => {
  expect(
    lines(`test("t", async () => {
  const before = await page.evaluate(() => document.body.getBoundingClientRect().top);
  await page.hover("#row");
  await row.evaluate((element) => element.ownerDocument.elementFromPoint(1, 1));
});`),
  ).toEqual([3]);
});

test("follows hovers and reads through helpers of the same file", () => {
  expect(
    lines(`const point = (target) => target.hover();
const measure = () => sample.boundingBox();
test("t", async () => {
  const before = await measure();
  await point(band);
  expect(await measure()).toEqual(before);
});`),
  ).toEqual([5]);
});

test("leaves hoverInPlace, hovers without a read on both sides, and other flows alone", () => {
  expect(
    lines(`test("t", async () => {
  const before = await sample.boundingBox();
  await hoverInPlace(band, { x: 3, y: 3 });
  expect(await sample.boundingBox()).toEqual(before);
  await band.hover();
  expect(await tooltip.textContent()).toBe("A");
});
test("u", async () => {
  await band.hover();
  expect(await tooltip.boundingBox()).not.toBeNull();
});
test("v", async () => {
  const before = await sample.boundingBox();
  await run(async () => band.hover());
  expect(await sample.boundingBox()).toEqual(before);
});`),
  ).toEqual([]);
});

test("a // hover: comment with a reason allows the hover; an empty reason does not", () => {
  const found = checkHoverInPlaceSource(
    "demo.browser.test.ts",
    `test("t", async () => {
  const before = await sample.boundingBox();
  // hover: only widths are compared, and a scroll keeps them
  await band.hover();
  await other.hover(); // hover:
  expect((await sample.boundingBox())?.width).toBe(before?.width);
});`,
  );
  expect(found.map((finding) => finding.line)).toEqual([5]);
  expect(found[0]!.message).toEndWith("the // hover: reason must be non-empty.");
});
