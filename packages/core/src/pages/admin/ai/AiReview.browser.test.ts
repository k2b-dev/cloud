import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Browser, Page, Route } from "playwright";
import { launchBrowser } from "../../../../../ui/test/browser";
import { aiAreaBrowserFixture } from "./AiArea.browser-fixture";
import { aiFixtureCatalog } from "./AiArea.fixture-data";

let browser: Browser;
let fixture: Awaited<ReturnType<typeof aiAreaBrowserFixture>>;
let page: Page;
const catalog = aiFixtureCatalog();
const conflict = (current: unknown) => ({
  code: "conflict",
  current,
  changedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" },
  changedAt: "2026-10-27T17:42:00.000Z",
});
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const goto = async (query: string) => {
  page.on("pageerror", (error) => console.error("PAGE ERROR", error.message));
  await page.goto(`${fixture.url}?locale=en&${query}`);
  await page.waitForSelector('body[data-ready="true"]');
};
const save = () => page.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).click();

beforeAll(async () => {
  fixture = await aiAreaBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  await page.addInitScript((at) => {
    globalThis.Date = new Proxy(Date, {
      construct: (target, args) => Reflect.construct(target, args.length ? args : [at]),
      apply: (target) => new target(at).toString(),
      get: (target, key, receiver) => (key === "now" ? () => at : Reflect.get(target, key, receiver)),
    });
  }, Date.parse("2026-10-27T18:00:00.000Z"));
});
afterAll(async () => {
  await browser?.close();
  fixture?.close();
});

test("provider conflicts render, merge and discard without reading a cleared accessor", async () => {
  const provider = {
    ...catalog.providers[0]!,
    revision: 4,
    models: catalog.models.filter((entry) => entry.providerId === "cortecs"),
    baseUrl: "https://new.example.test/v1",
  };
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/providers/cortecs", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(provider), 409);
  });
  await goto("sec=providers&p=cortecs&pane=conn");
  await page.getByRole("textbox", { name: /^Name/ }).fill("My connection");
  await save();
  await page.getByRole("button", { name: "Merge and save" }).waitFor();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role="alert"]').length > 0);
  await page.getByRole("button", { name: "Discard my changes" }).click();
  expect(await page.getByRole("textbox", { name: /^Name/ }).inputValue()).toBe(provider.label);
  expect(await page.getByRole("textbox", { name: /^Base URL/ }).inputValue()).toBe(provider.baseUrl);
  expect(requests[1]).toEqual(expect.objectContaining({ revision: 4, label: "My connection", baseUrl: provider.baseUrl }));
}, 30_000);

test("model merges preserve the complete draft and remotely changed activation; discard is safe", async () => {
  const model = catalog.models[0]!;
  const theirs = {
    ...model,
    revision: 4,
    enabled: false,
    icon: { kind: "emoji", emoji: "🌿" },
    variants: catalog.variants.filter((entry) => entry.modelId === model.id),
    access: { revision: 2, entries: [] },
  };
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/models/${model.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(theirs), 409);
  });
  await goto(`sec=providers&p=cortecs&m=${model.id}`);
  await page.getByRole("textbox", { name: /^Display name/ }).fill("My model");
  await save();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ label: "My model", enabled: false, icon: theirs.icon, revision: 4 }));
  expect(requests[1]).not.toHaveProperty("access");
  await page.getByRole("button", { name: "Discard my changes" }).click();
  expect(await page.getByRole("textbox", { name: /^Display name/ }).inputValue()).toBe(model.label);
}, 30_000);

test("budget conflicts merge independent fields and decide overlapping fields using the shown default", async () => {
  const theirs = {
    enabled: true,
    revision: 5,
    unit: "EUR",
    rules: [
      {
        scope: "*",
        hours: 24,
        anchor: "2026-10-26T00:00:00.000Z",
        grants: [{ principal: { type: "authenticated" }, limit: 20 }],
        peopleAtLimit: 2,
      },
      { scope: "remote", hours: 168, anchor: "2026-10-26T00:00:00.000Z", grants: [] },
    ],
  };
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai-quotas", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(theirs), 409);
  });
  await goto("sec=budgets&rule=*");
  await page.getByRole("spinbutton").first().fill("15");
  await save();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({
      revision: 5,
      rules: [
        expect.objectContaining({ scope: "*", hours: 24, grants: [expect.objectContaining({ limit: 15 })] }),
        expect.objectContaining({ scope: "remote" }),
      ],
    }),
  );
}, 30_000);

test("concurrently created budget scope replaces once instead of duplicating", async () => {
  const theirs = {
    enabled: true,
    revision: 5,
    rules: [{ scope: "*", hours: 24, anchor: "2026-10-26T00:00:00.000Z", grants: [], peopleAtLimit: 0 }],
  };
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai-quotas", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(theirs), 409);
  });
  await goto("sec=budgets&rule=new");
  expect(await page.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).isDisabled()).toBe(true);
  await goto("sec=budgets&rule=new&state=empty");
  await save();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ rules: [expect.objectContaining({ scope: "*", hours: 24 })] }));
}, 30_000);

test("partial provider creation retries only pending key and header writes; native dismiss stays guarded", async () => {
  let posts = 0;
  let keys = 0;
  let headers = 0;
  const revisions: unknown[] = [];
  const provider = { ...catalog.providers[0]!, id: "demo", revision: 1 };
  await page.route("**/api/admin/core/ai/providers", async (route) => {
    posts++;
    await json(route, provider);
  });
  await page.route("**/api/admin/core/ai/providers/demo/credential", async (route) => {
    keys++;
    revisions.push(route.request().postDataJSON());
    await json(route, keys === 1 ? { message: "Synthetic key failure" } : { ...provider, revision: 2 }, keys === 1 ? 500 : 200);
  });
  await page.route("**/api/admin/core/ai/providers/demo/headers", async (route) => {
    headers++;
    revisions.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic header failure" }, 500);
  });
  await goto("sec=providers");
  await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio").first().focus();
  expect(await dialog.getByRole("radio").first().getAttribute("tabindex")).toBe("0");
  expect(await dialog.getByRole("radio").nth(1).getAttribute("tabindex")).toBe("-1");
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Demo");
  await dialog.getByRole("textbox", { name: /^Base URL/ }).fill("https://demo.example.test/v1");
  await dialog.getByLabel("API key", { exact: false }).fill("fictional-key");
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog.getByRole("button", { name: "Add header" }).click();
  await dialog.getByPlaceholder("Name", { exact: true }).fill("x-demo");
  await dialog.getByPlaceholder("Value", { exact: true }).fill("fictional-value");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dialog.getByRole("button", { name: "Save and choose models" }).click();
    await dialog.getByText(attempt === 1 ? "Synthetic key failure" : "Synthetic header failure", { exact: true }).waitFor();
  }
  expect(posts).toBe(1);
  expect(keys).toBe(2);
  expect(headers).toBe(2);
  expect(revisions[revisions.length - 1]).toEqual(expect.objectContaining({ revision: 2 }));
}, 30_000);

test("empty model listing accepts a manual id and exposes a globally unique editable id", async () => {
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/providers/cortecs/models", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic rejection" }, 400);
  });
  await goto("sec=providers&p=cortecs&state=listempty");
  await page.getByRole("button", { name: "Add models", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Enter a model ID manually").fill("vendor/gpt-oss-120b");
  await dialog.getByText("Advanced", { exact: true }).click();
  const id = dialog.getByLabel("Model ID · vendor/gpt-oss-120b", { exact: true });
  expect(await id.inputValue()).toBe("cortecs-vendor-gpt-oss-120b");
  await id.fill("custom-model");
  await dialog.getByRole("button", { name: /Add 1/ }).click();
  await dialog.getByText("Synthetic rejection", { exact: true }).waitFor();
  expect(requests).toEqual([[expect.objectContaining({ id: "custom-model", providerModel: "vendor/gpt-oss-120b" })]]);
}, 30_000);

test("variant merge and discard keep override switches and use captured snapshots", async () => {
  const variant = catalog.variants[2]!;
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/variants/${variant.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict({ ...variant, revision: 4, hint: "Remote hint" }), 409);
  });
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b");
  await page.locator('[data-ai-variant="schnell"]').click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("switch", { name: "Own prices", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Input" }).fill("2");
  await dialog.getByRole("spinbutton", { name: "Output" }).fill("3");
  await dialog.getByRole("switch", { name: "Own output limit", exact: true }).click();
  await dialog.getByRole("spinbutton", { name: "Max output", exact: true }).fill("4000");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Merge and save" }).click();
  await dialog.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({
      revision: 4,
      pricing: { inputPerMillion: 2, outputPerMillion: 3 },
      maxOutputTokens: 4000,
      hint: "Remote hint",
    }),
  );
  await dialog.getByRole("button", { name: "Discard my changes" }).click();
  expect(await dialog.getByRole("switch", { name: "Own prices", exact: true }).isChecked()).toBe(false);
}, 30_000);

test("detail failures, missing models and no selection have distinct recovery states", async () => {
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b&state=detailfail");
  await page.getByText("AI settings could not be loaded", { exact: true }).first().waitFor();
  expect(await page.getByRole("link", { name: "Try again", exact: true }).count()).toBeGreaterThan(0);
  await goto("sec=providers&p=cortecs&m=missing&state=detailempty");
  await page.getByText("This model no longer exists", { exact: true }).waitFor();
  await goto("sec=providers&p=cortecs");
  expect(await page.getByText("This model no longer exists", { exact: true }).count()).toBe(0);
}, 30_000);

for (const kind of ["provider", "models", "variant", "delete"] as const) {
  test(`${kind} dialog guards Escape, backdrop and close while its write is pending`, async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const path =
      kind === "provider"
        ? "**/api/admin/core/ai/providers"
        : kind === "models"
          ? "**/api/admin/core/ai/providers/cortecs/models"
          : kind === "variant"
            ? "**/api/admin/core/ai/models/gpt-oss-120b/variants"
            : "**/api/admin/core/ai/models/mistral-small";
    await page.route(path, async (route) => {
      if (route.request().method() === "GET") return route.fallback();
      started?.();
      await pending;
      await json(route, { message: "Synthetic rejected write" }, 500);
    });
    try {
      if (kind === "provider") {
        await goto("sec=providers");
        await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
        await page.getByRole("radio").first().click();
        await page.getByRole("dialog").getByRole("textbox", { name: /^Name/ }).fill("Demo");
        await page
          .getByRole("dialog")
          .getByRole("textbox", { name: /^Base URL/ })
          .fill("https://demo.example.test/v1");
        await page.getByRole("button", { name: "Save and choose models" }).click();
      } else if (kind === "models") {
        await goto("sec=providers&p=cortecs&state=listempty");
        await page.getByRole("button", { name: "Add models", exact: true }).filter({ visible: true }).first().click();
        await page.getByLabel("Enter a model ID manually").fill("demo");
        await page.getByRole("button", { name: "Add 1 model", exact: true }).click();
      } else if (kind === "variant") {
        await goto("sec=providers&p=cortecs&m=gpt-oss-120b");
        await page.getByRole("button", { name: "Add variant", exact: true }).click();
        await page.getByRole("dialog").getByRole("textbox", { name: /^Name/ }).fill("Demo");
        await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      } else {
        await goto("sec=providers&p=cortecs&m=mistral-small");
        await page.locator('[data-ai-action="delete-model"]').click();
        const selectors = page.getByRole("dialog").getByRole("combobox");
        await selectors.first().waitFor();
        for (const select of await selectors.all()) {
          await select.click();
          await page
            .getByRole("option", { name: /Leave empty/ })
            .first()
            .click();
        }
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /delete/i })
          .filter({ visible: true })
          .last()
          .click();
      }
      await didStart;
      const dialog = page.getByRole("dialog");
      await page.keyboard.press("Escape");
      expect(await dialog.isVisible()).toBe(true);
      await page.mouse.click(2, 2);
      expect(await dialog.isVisible()).toBe(true);
      expect(await dialog.getByRole("button", { name: "Cancel", exact: true }).isDisabled()).toBe(true);
      release?.();
      await dialog.getByText("Synthetic rejected write", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    } finally {
      release?.();
    }
  }, 30_000);
}

test("model conflict retry keeps edited icon and principal grants", async () => {
  const model = catalog.models[0]!;
  const theirs = {
    ...model,
    label: "Remote name",
    revision: 4,
    icon: { kind: "emoji", emoji: "🌿" },
    variants: catalog.variants.filter((entry) => entry.modelId === model.id),
    access: {
      revision: 1,
      entries: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          principal: { type: "user", userId: "33333333-3333-4333-8333-333333333333" },
          displayName: "Jona Beispiel",
          permission: "read",
          createdAt: "2026-10-02T09:00:00.000Z",
        },
      ],
    },
  };
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/models/${model.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(theirs), 409);
  });
  await goto(`sec=providers&p=cortecs&m=${model.id}&state=modeldraft`);
  await page.getByRole("radio", { name: "Provider mark", exact: true }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await save();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({ icon: { kind: "provider" }, label: "Remote name", access: { expectedRevision: 1, entries: [] } }),
  );
}, 30_000);

for (const area of ["provider", "budget"] as const) {
  test(`malformed ${area} conflict leaves a recoverable form instead of a stuck busy state`, async () => {
    await page.route(area === "provider" ? "**/api/admin/core/ai/providers/cortecs" : "**/api/admin/core/ai-quotas", (route) =>
      json(route, conflict({ invalid: true }), 409),
    );
    await goto(area === "provider" ? "sec=providers&p=cortecs&pane=conn" : "sec=budgets&rule=*");
    if (area === "provider") await page.getByRole("textbox", { name: /^Name/ }).fill("My connection");
    else await page.getByRole("spinbutton").first().fill("15");
    await save();
    await page.getByRole("alert").filter({ hasText: "Could not save" }).waitFor();
    expect(await page.getByRole("button", { name: "Save", exact: true }).filter({ visible: true }).isDisabled()).toBe(false);
  }, 30_000);
}

test("delete offers only replacements that preserve every capability of the assigned source model", async () => {
  await goto("sec=providers&p=cortecs&m=mistral-small");
  await page.locator('[data-ai-action="delete-model"]').click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Gemini Flash/ }).waitFor();
  expect(await page.getByRole("option", { name: /GPT-OSS/ }).count()).toBe(0);
  expect(await page.getByRole("option", { name: /Claude/ }).count()).toBe(0);
}, 30_000);

test("provider selection supports arrow keys and focuses the form on a phone without overflowing", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto("sec=providers");
  await page.getByRole("button", { name: "Add provider", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("radio").first().focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  expect(await dialog.getByRole("textbox", { name: /^Name/ }).getAttribute("placeholder")).toBe("OpenRouter");
}, 30_000);

test("provider technical messages stay separate from localized recovery copy", async () => {
  await goto("sec=providers&p=cortecs&pane=conn&state=unreachable");
  expect(await page.getByText("Keine Antwort nach 10 s.", { exact: true }).last().isVisible()).toBe(false);
  await page.getByText("Technical details", { exact: true }).last().click();
  expect(await page.getByText("Keine Antwort nach 10 s.", { exact: true }).last().isVisible()).toBe(true);
}, 30_000);

test("model conflict retry retains a locally changed access mode", async () => {
  const model = catalog.models[0]!;
  const theirs = {
    ...model,
    label: "Remote name",
    revision: 4,
    variants: catalog.variants.filter((entry) => entry.modelId === model.id),
    access: {
      revision: 1,
      entries: [
        {
          id: "44444444-4444-4444-8444-444444444444",
          principal: { type: "authenticated" },
          permission: "read",
          createdAt: "2026-10-02T09:00:00.000Z",
        },
      ],
    },
  };
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/models/${model.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(theirs), 409);
  });
  await goto(`sec=providers&p=cortecs&m=${model.id}`);
  await page.getByRole("radio", { name: "Only selected people and groups", exact: true }).click();
  await save();
  await page.getByRole("button", { name: "Merge and save" }).click();
  await page.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ label: "Remote name", access: { expectedRevision: 1, entries: [] } }));
}, 30_000);
