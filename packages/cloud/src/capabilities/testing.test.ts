import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { type CapabilityExecutionContext, type CapabilityResult, defineCapabilities } from "../contracts/capabilities";
import { buildProjectedUser } from "../services/session/user";
import { assertResourceOpenLink, assertResourceOpenLinks, compileCapabilityManifest, withResourceOpenLinkAssertions } from "./testing";

test("validates the first top-level open destination", () => {
  const open = { rel: "open" as const, href: "/app/mail/MbA123/compose/DrG789" };
  expect(assertResourceOpenLink({ links: [{ rel: "download", href: "/api/download" }, open] })).toEqual(open);
  expect(() => assertResourceOpenLink({})).toThrow("top-level open link");
  expect(() => assertResourceOpenLink({ links: [{ rel: "edit", href: open.href }] })).toThrow("top-level open link");
  for (const href of ["https://example.test/app", "//example.test/app", "/" + "x".repeat(2048)]) {
    expect(() => assertResourceOpenLink({ links: [{ rel: "open", href }] })).toThrow();
  }
});

test.each(["single", "list", "multiple", "nested"])("guards every Query and Action success returning %s resources", async (shape) => {
  const ref = { type: "demo.item", id: "one" };
  const second = { type: "demo.item", id: "two" };
  const links = [{ rel: "open" as const, href: "/app/demo" }];
  let result: CapabilityResult<unknown>;
  const operation = {
    title: "Read item",
    description: "Read a resource result",
    input: z.object({ id: z.string().describe("Stable item id") }).strict(),
    data: z.unknown(),
    openWorld: false,
    run: (_input: { id: string }, _context: CapabilityExecutionContext) => ok(result),
  };
  const definitions = withResourceOpenLinkAssertions(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item", reader: "read" } },
      queries: { read: { ...operation }, browse: { ...operation } },
      actions: { create: { ...operation, title: "Create item", destructive: false, idempotency: "none" } },
    }),
  );
  const user = buildProjectedUser({ id: "reader", provider: "local", profile: "user", uid: "reader", display_name: "Reader" });
  const context: CapabilityExecutionContext = {
    locale: "en",
    origin: "http",
    requestId: "links-test",
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    user,
    signal: new AbortController().signal,
  };
  for (const run of [definitions.queries.read.run, definitions.queries.browse.run, definitions.actions.create.run]) {
    switch (shape) {
      case "list":
        result = { data: [{ ref, links }], refs: [ref] };
        break;
      case "multiple":
        result = {
          data: [
            { ref, links },
            { ref: second, links },
          ],
          refs: [ref, second],
        };
        break;
      case "nested":
        result = { data: { results: [{ ref, links }] } };
        break;
      default:
        result = { data: {}, refs: [ref], links };
    }
    expect((await run({ id: ref.id }, context)).ok).toBe(true);
    result = {
      ...result,
      links: undefined,
      data: shape === "single" ? {} : { results: [{ ref }] },
    };
    await expect(run({ id: ref.id }, context)).rejects.toThrow("resource link contract failed");
  }
});

// The same guard runs on every exercised Query and Action in provider behavior suites.
test("checks single resources, lists, multiple refs and nested resources, and ignores non-resource results", () => {
  const manifest = compileCapabilityManifest(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item", reader: "read" } },
      queries: {
        read: {
          title: "Read",
          description: "Read an item",
          openWorld: false,
          input: z.object({ id: z.string().describe("Stable resource id") }).strict(),
          data: z.unknown(),
          run: () => ok({ data: {} }),
        },
      },
    }),
  );
  const ref = { type: "demo.item", id: "one" };
  const second = { type: "demo.item", id: "two" };
  const links = [{ rel: "open" as const, href: "/app/demo/one" }];
  const resource = { ref, links };
  for (const result of [
    { data: {}, refs: [ref], links },
    { data: {}, refs: [ref, second], links },
    { data: [resource], refs: [ref] },
    { data: { results: [resource, { ref: second, links }] }, refs: [ref, second] },
    { data: {}, refs: [] },
    { data: { changed: true } },
  ])
    expect(() => assertResourceOpenLinks(result, manifest)).not.toThrow();
  for (const result of [
    { data: {}, refs: [ref] },
    { data: {}, refs: [ref], links: [{ rel: "edit" as const, href: "/app/demo/one" }] },
    { data: [{ ref }] },
    { data: [resource, { ref: second }], refs: [ref, second] },
  ])
    expect(() => assertResourceOpenLinks(result, manifest)).toThrow("must return an open link");
});
