import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

for (const savedDate of ["2026-08-01", null]) {
  domTest(`edit forms preserve saved date ${savedDate} instead of the creation default`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let submitted: unknown;
    globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      submitted = JSON.parse(String(init?.body));
      return Response.json({});
    }, { preconnect: originalFetch.preconnect });
    const { default: FormSubmit } = await import("./PublicFormSubmit.island");
    const dispose = render(() => <FormSubmit
      submitUrl="/save"
      form={{ id: "FORM01", name: "Payment", config: { fields: [{ kind: "user_input", fieldId: "Date01", defaultValue: "2026-09-15" }] } }}
      initialRecord={{ values: { Date01: savedDate }, version: 1, inlineCreates: {} }}
      fields={[{
        id: "Date01", tableId: "TABLE1", name: "Date", type: "date", config: {}, required: false,
        description: null, deletedAt: null, createdAt: "2026-09-14T12:00:00Z", updatedAt: "2026-09-14T12:00:00Z",
        position: 0, presentable: false, hideInTable: false, defaultValue: null, indexed: false, uniqueConstraint: false,
      }]}
    />, dom.root);
    try {
      dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Bun.sleep(10);
      expect(submitted).toMatchObject({ data: { Date01: savedDate }, version: 1 });
    } finally { dispose(); globalThis.fetch = originalFetch; dom.cleanup(); }
  });
}

domTest("app relation forms show SSR labels and search through the published form endpoint", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requested: URL[] = [];
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      requested.push(new URL(input instanceof Request ? input.url : String(input)));
      return Response.json({ items: [{ id: "CHILD2", label: "Another partner" }] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: FormSubmit } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () => (
      <FormSubmit
        submitUrl="/api/grids/custom-apps/runtime/APP001/edit/partner/submit?bill_id=BILL01"
        form={{ id: "FORM01", name: "Partner", config: { fields: [{ kind: "user_input", fieldId: "FIELD1" }] } }}
        initialRecord={{ values: { FIELD1: ["CHILD1"] }, version: 1, inlineCreates: {} }}
        relationLabels={{ CHILD1: "Existing partner" }}
        relationLookupFields={["FIELD1"]}
        fields={[
          {
            id: "FIELD1",
            tableId: "TABLE1",
            name: "Partner",
            type: "relation",
            config: { targetTableId: "TABLE2", cardinality: "one" },
            required: false,
            description: null,
            deletedAt: null,
            createdAt: "2026-09-14T12:00:00Z",
            updatedAt: "2026-09-14T12:00:00Z",
            position: 0,
            presentable: false,
            hideInTable: false,
            defaultValue: null,
            indexed: false,
            uniqueConstraint: false,
          },
        ]}
      />
    ),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("Existing partner");
    const picker = dom.root.querySelector<HTMLElement>('[role="combobox"]');
    expect(picker).not.toBeNull();
    picker!.click();
    await Bun.sleep(350);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((url) => url.pathname === "/api/grids/custom-apps/runtime/APP001/edit/partner/relations/FIELD1/lookup")).toBe(
      true,
    );
    expect(requested[0]!.searchParams.get("bill_id")).toBe("BILL01");
    expect(requested[0]!.searchParams.get("_exclude")).toContain("CHILD1");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("form warns on dirty and failed saves, clears after saving and removes its unload listener", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let respond: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async () =>
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    { preconnect: originalFetch.preconnect },
  );
  const { default: FormSubmit } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () => (
      <FormSubmit
        submitUrl="/save"
        form={{
          id: "FORM01",
          name: "Edit",
          config: {
            fields: [{ kind: "user_input", fieldId: "FIELD1" }],
          },
        }}
        fields={[
          {
            id: "FIELD1",
            tableId: "TABLE1",
            name: "Subject",
            type: "text",
            config: {},
            required: false,
            description: null,
            deletedAt: null,
            createdAt: "2026-09-14T12:00:00Z",
            updatedAt: "2026-09-14T12:00:00Z",
            position: 0,
            presentable: true,
            hideInTable: false,
            defaultValue: null,
            indexed: false,
            uniqueConstraint: false,
          },
        ]}
      />
    ),
    dom.root,
  );
  const leaving = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    expect(leaving()).toBe(false);
    const input = dom.root.querySelector("input")!;
    input.value = "Changed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(leaving()).toBe(true);
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(10);
    expect(respond).toBeDefined();
    expect(leaving()).toBe(true);
    respond!(Response.json({ message: "Invalid" }, { status: 422 }));
    await Bun.sleep(10);
    expect(leaving()).toBe(true);
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(10);
    respond!(Response.json({}));
    await Bun.sleep(10);
    expect(leaving()).toBe(false);
  } finally {
    dispose();
    expect(leaving()).toBe(false);
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
