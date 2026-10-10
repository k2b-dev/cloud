import { expect, test } from "bun:test";
import { webAddressesIn } from "./web-provenance";

test("finds whole addresses only, never one inside a longer address or host name", () => {
  const typed = webAddressesIn(
    "Read example.org/news, then https://notcollector.example/report?token=SECRET and https://portal.example/#/x/collector.example/r?t=1. Mail ada@bank.example.",
    { typed: true },
  );
  expect(typed.has("https://example.org/news")).toBe(true);
  expect(typed.has("http://example.org/news")).toBe(true);
  expect(typed.has("https://notcollector.example/report?token=SECRET")).toBe(true);
  expect(typed.has("https://collector.example/report?token=SECRET")).toBe(false);
  expect(typed.has("https://collector.example/r?t=1")).toBe(false);
  expect(typed.has("https://bank.example/")).toBe(false);
  // An address nested in another one belongs to it.
  const archived = webAddressesIn("https://web.archive.org/web/2024/https://bank.example/acct?token=X", { typed: true });
  expect(archived.has("https://bank.example/acct?token=X")).toBe(false);
  expect(archived.has("https://web.archive.org/web/2024/https://bank.example/acct?token=X")).toBe(true);
});

test("reads addresses as a page or a person writes them", () => {
  const links = webAddressesIn(
    "See [history](https://quotes.example.com/history/nvda), <https://a.example>, (https://en.wikipedia.org/wiki/Foo_(bar)) and **https://b.example/x**.",
  );
  expect([...links]).toEqual([
    "https://quotes.example.com/history/nvda",
    "https://a.example/",
    "https://en.wikipedia.org/wiki/Foo_(bar)",
    "https://b.example/x",
  ]);
  // Without `typed`, a host without scheme is no link.
  expect(webAddressesIn("example.org/news").size).toBe(0);
  // Dropping a fragment or upgrading to HTTPS carries nothing the address did not carry.
  expect([...webAddressesIn("http://c.example/doc#part")]).toEqual([
    "http://c.example/doc#part",
    "http://c.example/doc",
    "https://c.example/doc#part",
    "https://c.example/doc",
  ]);
  expect(webAddressesIn(`https://d.example/${"x".repeat(2_000)}`).size).toBe(0);
});
