import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { codePageFixture } from "./code-page.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: CodePage }, { LocaleProvider, toast }, client] = await Promise.all([
      import("./CodePage"),
      import("@k2b/ui"),
      import("../../capabilities/client"),
    ]);
    return { CodePage, LocaleProvider, toast, client };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const privateValue = "fixture-private-credential";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const open = (state: "secrets" | "secrets-empty") => {
  const dom = createDomTestHarness();
  const { CodePage, LocaleProvider } = modules!;
  delegateEvents(["click", "input"]);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(CodePage, { data: codePageFixture(state, "en") });
        },
      }),
    dom.root,
  );
  const button = (label: string) => {
    const match = [...dom.document.querySelectorAll<HTMLElement>("button")].find(
      (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
    );
    if (!match) throw new Error(`Missing control ${label}`);
    return match;
  };
  const field = (label: string) => {
    const match = [...dom.document.querySelectorAll("label")].find((element) => element.textContent?.includes(label));
    const input = match?.htmlFor ? dom.document.getElementById(match.htmlFor) : match?.querySelector("input");
    if (!input) throw new Error(`Missing field ${label}`);
    return input as HTMLInputElement;
  };
  const type = (label: string, value: string) => {
    const input = field(label);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { dom, dispose, button, field, type };
};

test.skipIf(isServer)("creating sends the value once, without an idempotency key, and forgets it even when refused", async () => {
  const { client } = modules!;
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: false,
    error: { code: "BAD_INPUT", message: "Fixture refusal", status: 400 },
  });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: 1, allowed: true }));
  const page = open("secrets-empty");
  try {
    page.button("Create secret").click();
    await tick();
    page.type("Name", "LAGER_TOKEN");
    page.type("Only send to address", "https://api.lager-beispiel.de/");
    page.type("Path starts with", "/v2/");
    page.type("Header", "Authorization");
    page.type("Value", privateValue);
    page.button("Create and submit").click();
    await tick();
    await tick();
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(privateValue);
    expect(invoke).toHaveBeenCalledTimes(1);
    const invocation = invoke.mock.calls[0]![0];
    expect(invocation.capabilityId).toBe("code.secret.set");
    expect(invocation.idempotencyKey).toBeUndefined();
    expect(invocation.input).toEqual({
      name: "LAGER_TOKEN",
      value: privateValue,
      binding_revision: null,
      binding: { origin: "https://api.lager-beispiel.de", pathPrefix: "/v2/", headers: ["authorization"] },
    });
    expect(page.field("Value").value).toBe("");
    expect(page.dom.document.body.innerHTML).not.toContain(privateValue);
    expect(page.dom.window.location.href).not.toContain(privateValue);
    // Prompts are one shared queue: an open dialog would hold back the next test's.
    page.button("Cancel").click();
    await tick();
  } finally {
    page.dispose();
    invoke.mockRestore();
    fetchSpy.mockRestore();
    page.dom.cleanup();
  }
});

test.skipIf(isServer)("this Cloud's own address is refused before any value leaves the form", async () => {
  const { client } = modules!;
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema");
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: 1, allowed: false }));
  const page = open("secrets-empty");
  try {
    page.button("Create secret").click();
    await tick();
    page.type("Name", "LAGER_TOKEN");
    page.type("Only send to address", "https://cloud.moebel-beispiel.de");
    page.type("Value", privateValue);
    page.button("Create and submit").click();
    await tick();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(fetchSpy.mock.calls)).not.toContain(privateValue);
    expect(page.dom.document.body.textContent).toContain("This Cloud's own addresses are not allowed.");
    expect((page.button("Create and submit") as HTMLButtonElement).disabled).toBe(true);
    // The person typed it and nothing was sent, so correcting the address does not lose it.
    expect(page.field("Value").value).toBe(privateValue);
    page.type("Only send to address", "https://api.lager-beispiel.de");
    expect((page.button("Create and submit") as HTMLButtonElement).disabled).toBe(false);
    page.button("Cancel").click();
    await tick();
  } finally {
    page.dispose();
    invoke.mockRestore();
    fetchSpy.mockRestore();
    page.dom.cleanup();
  }
});

test.skipIf(isServer)("deleting always asks first and names the Code target", async () => {
  const { client } = modules!;
  const { prompts } = await import("@k2b/ui");
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: false,
    error: { code: "CONFLICT", message: "Fixture refusal", status: 409 },
  });
  const confirm = spyOn(prompts, "confirm").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const notice = spyOn(modules!.toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const page = open("secrets");
  try {
    page.button("Delete …").click();
    await tick();
    expect(invoke).not.toHaveBeenCalled();
    page.button("Delete …").click();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      capabilityId: "code.secret.delete",
      target: { type: "core.code" },
      input: { name: "LAGER_TOKEN", binding_revision: "00000000-0000-4000-8000-0000000000c1" },
      idempotencyKey: expect.any(String),
    });
  } finally {
    page.dispose();
    invoke.mockRestore();
    confirm.mockRestore();
    notice.mockRestore();
    page.dom.cleanup();
  }
});
