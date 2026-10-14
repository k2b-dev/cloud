import { expect, spyOn, test } from "bun:test";
import type { ServiceAccountCredential } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../ui/test/dom";

const BASE_URL = "https://cloud.test/api/ai/openai/v1";
const TOKEN = "cld_test_behavior-test-token";
const credential: ServiceAccountCredential = {
  id: "b5b1655a-f49c-4380-a2fb-91a1d5179625",
  serviceAccountId: "c9b5a7b9-62c7-47ca-9c89-bdbdfe53af7a",
  name: "Desktop sync",
  kind: "api_token",
  status: "active",
  tokenPrefix: "cld_test",
  scopes: [],
  expiresAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-09-01T10:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
};

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const mockFetch = (route: (method: string, path: string, body: unknown) => Response | Promise<Response> | undefined) => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost/"), init);
        const path = new URL(request.url).pathname;
        const text = await request.text();
        const body: unknown = text ? JSON.parse(text) : undefined;
        calls.push({ method: request.method, path, body });
        return route(request.method, path, body) ?? Response.json({ code: "UNAVAILABLE" }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  return { calls, restore: () => spy.mockRestore() };
};

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { ui: await import("@k2b/ui"), ApiKeysSettings: (await import("./ApiKeysSettings.island.tsx")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const mount = (dom: DomTestHarness, openAiBaseUrl: string | null, initialKeys: ServiceAccountCredential[] = []) => {
  const { ui, ApiKeysSettings } = modules!;
  delegateEvents(["input", "click"]);
  return render(
    () =>
      createComponent(ui.LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(ApiKeysSettings, { initialKeys, openAiBaseUrl });
        },
      }),
    dom.root,
  );
};
const button = (dom: DomTestHarness, label: string) =>
  [...dom.document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent?.trim() === label);
const dialogText = (dom: DomTestHarness) => dom.document.querySelector("dialog")?.textContent ?? "";
const accessControl = (dom: DomTestHarness) => {
  const label = [...dom.document.querySelectorAll<HTMLLabelElement>("dialog label")].find(
    (element) => element.textContent?.trim() === "Access",
  );
  return label ? dom.document.getElementById(label.htmlFor) : null;
};
const submitName = (dom: DomTestHarness, name: string) => {
  const input = dom.document.querySelector<HTMLInputElement>('dialog input[placeholder="e.g. Desktop sync"]');
  if (!input) throw new Error("Missing API key name input");
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  button(dom, "Create key")!.click();
};
const keyRow = (dom: DomTestHarness, name: string) =>
  [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === "Revoke" && element.parentElement?.textContent?.includes(name),
  )?.parentElement;

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("without the OpenAI endpoint, creation omits access and shows only the token", async () => {
    const dom = createDomTestHarness();
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/me/api-keys") return Response.json({ credential, token: TOKEN }, { status: 201 });
    });
    const dispose = mount(dom, null);
    try {
      button(dom, "Add")!.click();
      await waitFor(() => Boolean(button(dom, "Create key")), "create dialog");
      expect(accessControl(dom)).toBeNull();
      expect(dom.document.querySelector('dialog [role="combobox"]')).toBeNull();
      expect(dialogText(dom)).not.toContain("Full access");
      expect(dialogText(dom)).not.toContain("AI models only");
      submitName(dom, credential.name);
      await waitFor(() => dialogText(dom).includes(TOKEN), "token dialog");
      expect(fetch.calls).toEqual([
        { method: "POST", path: "/api/me/api-keys", body: { name: credential.name, expiresAt: expect.any(String) } },
      ]);
      expect(dialogText(dom)).toContain("API key created");
      expect(dom.document.querySelector("dialog code")?.textContent).toBe(TOKEN);
      expect(dialogText(dom)).not.toContain("Base URL");
      expect(dialogText(dom)).not.toContain(BASE_URL);
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("choosing AI models only posts models access and shows the base URL and the new key's tag", async () => {
    const dom = createDomTestHarness();
    const modelsKey: ServiceAccountCredential = { ...credential, name: "Dictation app", scopes: ["ai:inference"] };
    const fetch = mockFetch((method, path) => {
      if (method === "POST" && path === "/api/me/api-keys") return Response.json({ credential: modelsKey, token: TOKEN }, { status: 201 });
    });
    const dispose = mount(dom, BASE_URL);
    try {
      button(dom, "Add")!.click();
      await waitFor(() => Boolean(button(dom, "Create key")), "create dialog");
      const access = accessControl(dom);
      expect(access).not.toBeNull();
      expect(access?.getAttribute("role")).toBe("combobox");
      expect(access?.textContent).toContain("Full access");
      access!.click();
      await waitFor(() => Boolean(dom.document.querySelector('[role="option"][aria-label="AI models only"]')), "access options");
      expect([...dom.document.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("aria-label"))).toEqual([
        "Full access",
        "AI models only",
      ]);
      dom.document.querySelector<HTMLButtonElement>('[role="option"][aria-label="AI models only"]')!.click();
      await waitFor(() => access?.textContent?.includes("AI models only") ?? false, "models access selected");
      submitName(dom, modelsKey.name);
      await waitFor(() => dialogText(dom).includes(TOKEN), "token dialog");
      expect(fetch.calls).toEqual([
        { method: "POST", path: "/api/me/api-keys", body: { name: modelsKey.name, expiresAt: expect.any(String), access: "models" } },
      ]);
      expect([...dom.document.querySelectorAll("dialog code")].map((code) => code.textContent)).toEqual([TOKEN, BASE_URL]);
      expect(dialogText(dom)).toContain("Base URL");
      expect(keyRow(dom, modelsKey.name)?.querySelector(".k2b-tag")?.textContent?.trim()).toBe("AI models only");
    } finally {
      modules!.ui.dialogCore.close();
      dispose();
      fetch.restore();
      dom.cleanup();
    }
  });

  test("initial credentials show the AI models only tag according to their scopes", () => {
    const dom = createDomTestHarness();
    const modelsKey: ServiceAccountCredential = {
      ...credential,
      id: "0156abca-3a63-41e6-a81e-e8e59a6b53e8",
      name: "Dictation app",
      scopes: ["ai:inference"],
    };
    const dispose = mount(dom, BASE_URL, [modelsKey, credential]);
    try {
      const modelsRow = keyRow(dom, modelsKey.name);
      const fullRow = keyRow(dom, credential.name);
      expect(modelsRow).toBeDefined();
      expect(fullRow).toBeDefined();
      expect(modelsRow?.querySelector(".k2b-tag")?.textContent?.trim()).toBe("AI models only");
      expect(fullRow?.querySelector(".k2b-tag")).toBeNull();
      expect(fullRow?.textContent).not.toContain("AI models only");
      expect(dom.root.querySelectorAll(".k2b-tag")).toHaveLength(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
