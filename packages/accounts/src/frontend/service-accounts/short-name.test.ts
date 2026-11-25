import { expect, test } from "bun:test";
import { shortName } from "./short-name";

test("a long name keeps its start and end around one ellipsis; a short one and signs outside the BMP stay whole", () => {
  expect(shortName("Laptop Jana")).toBe("Laptop Jana");
  const long = "Nachtlauf-Synchronisation-der-Lagerbestaende-mit-dem-Warenwirtschaftssystem-ohne-Leerzeichen";
  const short = shortName(long);
  expect([...short]).toHaveLength(48);
  expect(short.startsWith("Nachtlauf-Synchronisation")).toBe(true);
  expect(short.endsWith("ohne-Leerzeichen")).toBe(true);
  expect(short).toContain("…");
  expect([...shortName("🔑".repeat(60))]).toHaveLength(48);
});
