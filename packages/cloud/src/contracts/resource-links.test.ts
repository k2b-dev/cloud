import { expect, test } from "bun:test";
import { CapabilitySemanticLinkSchema, cloudResourceHref } from "./index";

test.each([
  ["AbC123", "AbC123"],
  ["a/b?c#d e", "a%2Fb%3Fc%23d%20e"],
  ["Grüße 東京", "Gr%C3%BC%C3%9Fe%20%E6%9D%B1%E4%BA%AC"],
])("encodes the resource id %s into one permalink segment", (id, encoded) => {
  const href = cloudResourceHref({ type: "mail.draft", id });
  expect(href).toBe(`/open/mail.draft/~${encoded}`);
  expect(CapabilitySemanticLinkSchema.safeParse({ rel: "open", href }).success).toBe(true);
});

test.each([".", "..", "~", "東京".repeat(256), "ü".repeat(512)])("preserves dot segments and maximum-length id %s", (id) => {
  const href = cloudResourceHref({ type: "demo.item", id });
  const url = new URL(href, "https://cloud.example");
  expect(url.pathname).toBe(href);
  expect(decodeURIComponent(url.pathname.split("/").at(-1)!.slice(1))).toBe(id);
});
