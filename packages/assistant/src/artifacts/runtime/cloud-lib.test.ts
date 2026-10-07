import { expect, test } from "bun:test";
import { boundMoney, chart, html } from "./lib";
import { parseCsv, toCsv } from "./sheet-lib";

test("cloud.html escapes values, joins arrays and keeps nested markup", () => {
  const items = ["<b>", "Müller & Söhne"];
  const markup = html`<ul>${items.map((item) => html`<li title="${item}">${item}</li>`)}</ul>${null}${false}`;
  expect(String(markup)).toBe('<ul><li title="&lt;b&gt;">&lt;b&gt;</li><li title="Müller &amp; Söhne">Müller &amp; Söhne</li></ul>');
  expect(markup.includes("<li")).toBe(true);
});

test("cloud.chart drops stdlib's fixed colors and sizes text in pixels", () => {
  const markup = String(chart({ kind: "bar", title: "Umsatz", data: [{ label: "Jan", value: 1200.5 }] }, "de-DE"));
  expect(markup).not.toContain("<style>");
  expect(markup).toStartWith('<div class="cloud-chart" data-chart-kind="bar"');
  expect(markup).toContain('role="img" aria-label="Umsatz"');
  expect(markup).toContain("1.200");
  expect(markup).toMatch(/<text\b[^>]* style="transform-origin:-?[\d.]+px -?[\d.]+px[^"]*">/);
  expect(() => chart({ kind: "map" }, "de-DE")).toThrow(/unknown kind "map"/);
});

test("parseCsv reads Excel CSV: windows-1252, semicolons, German numbers, codes stay text", async () => {
  // "ü" is 0xFC and "€" is 0x80 in Windows-1252.
  const bytes = new Uint8Array([
    ...Buffer.from("Name;PLZ;Betrag\r\nM"),
    0xfc,
    ...Buffer.from("ller;01234;1.234,56\r\nSchulz;80331;-12,50 "),
    0x80,
    0x0d,
    0x0a,
  ]);
  const rows = await parseCsv(new Blob([bytes]), {}, "de-DE");
  expect(rows).toEqual([
    { Name: "Müller", PLZ: "01234", Betrag: 1234.56 },
    { Name: "Schulz", PLZ: "80331", Betrag: -12.5 },
  ]);
  expect((await parseCsv("a,b\n1.5,x", {}, "en-US"))[0]).toEqual({ a: 1.5, b: "x" });
  expect((await parseCsv("a;b\n1,5;2", { numbers: false }, "de-DE"))[0]).toEqual({ a: "1,5", b: "2" });
});

test("toCsv writes Excel-friendly CSV and escapes formulas", async () => {
  const csv = await toCsv([{ Name: "=SUM(A1)", Betrag: 12.5, Notiz: 'sagt "hallo"; tschüss' }], {}, "de-DE");
  expect(csv).toBe('﻿Name;Betrag;Notiz\r\n\'=SUM(A1);12,5;"sagt ""hallo""; tschüss"\r\n');
});

test("chart thins complete labels and always supplies an escaped accessible name", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Category ${i} long`);
  const markup = String(
    chart({ kind: "bar", width: 300, title: "A & B", subtitle: '"report"', data: labels.map((label) => ({ label, value: 1 })) }, "en-US"),
  );
  expect(markup).not.toContain("…");
  expect(markup).toContain(labels[0]!);
  expect(labels.filter((label) => markup.includes(label)).length).toBeLessThan(labels.length);
  expect(markup).toContain('role="img" aria-label="A &amp; B — &quot;report&quot;"');
  expect(String(chart({ kind: "sparkline", data: [1, 2] }, "en-US"))).toContain('role="img"');
});
test("money defaults to the viewer locale; CSV dates remain text", async () => {
  const money = boundMoney("de-DE");
  const value = money.parse("1.234,56 €", { currency: "EUR" });
  expect(value.amount).toBe(123456);
  expect(money.format(value)).toContain("1.234,56");
  expect(await parseCsv("date;amount\n2026-10-07;12,5", {}, "de-DE")).toEqual([{ date: "2026-10-07", amount: 12.5 }]);
});

test("CSV preserves unsafe integer columns, unique headings and missing cells", async () => {
  expect(await parseCsv("id,name\n9007199254740993,large\n42,small", {}, "en-US")).toEqual([
    { id: "9007199254740993", name: "large" },
    { id: "42", name: "small" },
  ]);
  expect(await parseCsv("a,a,a,,column4\nleft,middle,right,blank,collision", {}, "en-US")).toEqual([
    { a: "left", a_2: "middle", a_3: "right", column4: "blank", column4_2: "collision" },
  ]);
  expect(await parseCsv("a,b\nleft", {}, "en-US")).toEqual([{ a: "left", b: "" }]);
});

for (const locale of ["en-US", "de-DE"])
  for (const delimiter of [undefined, ","])
    test(`CSV numbers round-trip in ${locale} with ${delimiter ?? "default"} delimiter`, async () => {
      const rows = [{ mass: 1.234, count: 1234 }];
      expect(await parseCsv(await toCsv(rows, { delimiter }, locale), { delimiter }, locale)).toEqual(rows);
    });

test("unambiguous columns decide ambiguous numeric columns before locale", async () => {
  expect(await parseCsv("Betrag;Menge\n1.234;1,5", {}, "en-US")).toEqual([{ Betrag: 1234, Menge: 1.5 }]);
});

for (const source of ['a,b\n"unterminated,x', "a,b\n1,2,3"])
  test("malformed CSV rejects with an invalid code and physical line", async () => {
    await expect(parseCsv(source, {}, "en-US")).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("line 2") });
  });

test("CSV diagnostics count blank and quoted physical lines", async () => {
  await expect(parseCsv("a,b\n,,\n1,2,3", {}, "en-US")).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("line 3"),
  });
  await expect(parseCsv('a,b\n"two\nlines",ok\n1,2,3', {}, "en-US")).rejects.toMatchObject({
    code: "invalid",
    message: expect.stringContaining("line 4"),
  });
});
