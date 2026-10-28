import { afterEach, describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

const posts: Array<{ payload: unknown; resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
let listFails = false;
if (!isServer)
  mock.module("@k2b/cloud/clients/core", () => ({
    coreClient: {
      admin: {
        identity: {
          "service-accounts": {
            $get: async () =>
              listFails
                ? Response.json({}, { status: 503 })
                : Response.json({
                    items: [
                      { id: "agent-id", name: "Release robot", kind: "agent" },
                      { id: "standalone-id", name: "Transcript integration", kind: "standalone" },
                    ],
                  }),
            ":id": {
              "api-keys": {
                $post: ({ json, param }: { json: unknown; param: unknown }) =>
                  new Promise<Response>((resolve, reject) => posts.push({ payload: { json, param }, resolve, reject })),
              },
            },
          },
        },
      },
    },
  }));
const flush = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};
const waitFor = async (condition: () => boolean) => {
  for (let count = 0; count < 100; count++) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for machine accounts");
};
const findButton = (doc: Document, text: string) => {
  const found = [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
};

describe("machine API key creation", () => {
  if (isServer) {
    test.skip("requires the package DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    posts.length = 0;
    listFails = false;
  });
  const setup = async (modelsAvailable = true) => {
    const dom = createDomTestHarness();
    const { CreateMachineKeyDialog } = await import("../src/frontend/service-accounts/CreateMachineKey.island");
    let closed = 0;
    const dispose = render(
      () =>
        createComponent(CreateMachineKeyDialog, {
          modelsAvailable,
          close: () => {
            closed++;
          },
        }),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    return { ...dom, closed: () => closed };
  };
  const choose = async (doc: Document) => {
    findButton(doc, "Choose a standalone account or agent").click();
    await flush();
    await waitFor(() => doc.body.textContent?.includes("Transcript integration") === true);
    findButton(doc, "Release robot").click();
    await flush();
    const name = doc.querySelector<HTMLInputElement>('input[type="text"]');
    if (!name) throw new Error("Missing name field");
    name.value = "Model cleanup";
    name.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const submit = (doc: Document) => doc.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  test("named machines, models default, pending guard, retained failure and one-time result", async () => {
    const dom = await setup();
    expect(findButton(dom.document, "Create API key").disabled).toBe(true);
    await choose(dom.document);
    submit(dom.document);
    submit(dom.document);
    await flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.payload).toEqual({ param: { id: "agent-id" }, json: { name: "Model cleanup", access: "models", expiresAt: null } });
    expect(findButton(dom.document, "Cancel").disabled).toBe(true);
    posts[0]!.resolve(Response.json({ message: "Account disabled" }, { status: 400 }));
    await flush();
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain("Account disabled");
    expect(dom.document.querySelector<HTMLInputElement>('input[type="text"]')?.value).toBe("Model cleanup");
    submit(dom.document);
    await flush();
    posts[1]!.resolve(Response.json({ token: "fictional-one-time-key" }));
    await flush();
    expect(dom.document.body.textContent).toContain("fictional-one-time-key");
    expect(dom.document.body.textContent).toContain("only be shown once");
    expect(dom.document.querySelector("form")).toBeNull();
    findButton(dom.document, "Done").click();
    expect(dom.closed()).toBe(1);
  });
  test("uncertain outcome cannot duplicate the credential", async () => {
    const dom = await setup();
    await choose(dom.document);
    submit(dom.document);
    await flush();
    posts[0]!.reject(new Error("Connection lost"));
    await flush();
    expect(dom.document.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(findButton(dom.document, "Create API key").disabled).toBe(true);
    submit(dom.document);
    await flush();
    expect(posts).toHaveLength(1);
    findButton(dom.document, "Cancel").click();
    expect(dom.closed()).toBe(1);
  });
  test("account lookup failure has a retry without discarding the form", async () => {
    listFails = true;
    const dom = await setup();
    findButton(dom.document, "Choose a standalone account or agent").click();
    await waitFor(() => dom.document.body.textContent?.includes("Could not load machine accounts") === true);
    listFails = false;
    findButton(dom.document, "Retry").click();
    await waitFor(() => dom.document.body.textContent?.includes("Transcript integration") === true);
    expect(findButton(dom.document, "Create API key").disabled).toBe(true);
  });
  test("disabled API explains prerequisite and offers full access", async () => {
    const dom = await setup(false);
    expect(dom.document.body.textContent).toContain("enable the OpenAI-compatible API");
    expect(dom.document.body.textContent).toContain("Full access");
  });
});
