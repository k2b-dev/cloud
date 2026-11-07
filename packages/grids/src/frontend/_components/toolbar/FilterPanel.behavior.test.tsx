import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
for (const kind of ["standalone", "agent"] as const) {
  domTest(`${kind}: principal filters hydrate selected account IDs within the directory`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const urls: URL[] = [];
    const id = "00000000-0000-4000-8000-000000000123";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        urls.push(new URL(input instanceof Request ? input.url : String(input)));
        return Response.json({ items: [{ kind: "service_account", serviceAccount: { id, name: "Catalog assistant", kind } }] });
      },
      { preconnect: originalFetch.preconnect },
    );
    const { PublicFieldSchema } = await import("../../../api/public-dto");
    const { default: FilterPanel } = await import("./FilterPanel");
    const field = PublicFieldSchema.parse({
      id: "FIELD1",
      tableId: "TABLE1",
      name: "Participants",
      type: "principal",
      config: {},
      position: 0,
      required: false,
      presentable: false,
      hideInTable: false,
      defaultValue: null,
      indexed: true,
      uniqueConstraint: false,
      description: null,
      deletedAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const dispose = render(
      () => <FilterPanel fields={[field]} rows={() => [{ fieldId: field.id, op: "containsAny", value: [id] }]} onRowsChange={() => {}} />,
      dom.root,
    );
    try {
      for (let attempt = 0; attempt < 200 && !dom.root.textContent?.includes("Catalog assistant"); attempt += 1) await Bun.sleep(10);
      expect(dom.root.textContent).toContain("Catalog assistant");
      expect(dom.root.textContent).not.toContain(id);
      expect(dom.root.querySelector(kind === "agent" ? ".ti-robot" : ".ti-key")).not.toBeNull();
      expect(urls[0]!.searchParams.get("kinds")).toBe("user,group,service_account");
      expect(urls[0]!.searchParams.get("service_account_ids")).toBe(id);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
