import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { measureV2Layout } from "@k2b/ui/v2/testing";
import type { Browser, Locator, Page, Route } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../../../../ui/test/browser";
import { aiAreaBrowserFixture } from "./AiArea.browser-fixture";
import { aiFixtureCatalog } from "./AiArea.fixture-data";

// Model classes, providers and budgets of the AI area on v2: each section keeps the layout rules at every width, the
// open entry lives in the address, every write keeps its revision and conflict handling, and dialogs stay open while
// their write runs.
setDefaultTimeout(30_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof aiAreaBrowserFixture>>;
let page: Page;
let errors: string[];
const catalog = aiFixtureCatalog();
const conflict = (current: unknown) => ({
  code: "conflict",
  current,
  changedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" },
  changedAt: "2026-10-27T17:42:00.000Z",
});
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const goto = async (query: string, width = 1440) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.goto(`${fixture.url}?locale=en&${query}`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
};
const main = () => page.locator("main");
const button = (name: string | RegExp) =>
  main()
    .getByRole("button", { name, exact: typeof name === "string" })
    .filter({ visible: true });
const save = () => button("Save").first().click();
const moreActions = async (entry: string) => {
  await main().getByRole("button", { name: "More actions" }).filter({ visible: true }).last().click();
  await page.getByRole("menuitem", { name: entry }).click();
};
/** A v2 switch is pressed at its label, as a person does. */
const flip = (scope: Locator, name: string) =>
  scope
    .locator("label")
    .filter({ has: page.getByRole("switch", { name, exact: true }) })
    .click();
/** The model of a class is chosen where its value stands: the menu in the facts of the open slot. */
const chooser = () => main().locator('[data-k2-part="Facts"]').getByRole("button").first();
const openVariant = (name: string) =>
  main()
    .getByRole("button", { name: new RegExp(`^${name}`) })
    .first()
    .click();

beforeAll(async () => {
  fixture = await aiAreaBrowserFixture();
  browser = await launchBrowser();
}, 120_000);
beforeEach(async () => {
  if (page) await page.close();
  fixture.reset();
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  errors = pageErrors(page);
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

test("classes, providers and budgets keep the v2 rules at every width, with no loader in the first picture", async () => {
  const paths = [
    "sec=classes",
    "sec=classes&slot=fast",
    "sec=classes&state=empty",
    "sec=providers",
    "sec=providers&p=cortecs",
    "sec=providers&p=cortecs&m=gpt-oss-120b",
    "sec=providers&p=cortecs&pane=conn&state=unreachable",
    "sec=providers&state=empty",
    "sec=providers&state=worst",
    "sec=budgets",
    "sec=budgets&rule=claude",
    "sec=budgets&rule=brake",
    "sec=budgets&state=worst",
    "state=noperm",
  ];
  for (const path of paths)
    for (const width of [1440, 1024, 390]) {
      await goto(path, width);
      // The v1 person picker, emoji picker and the people's model card stand in for missing v2 parts (k2b-ui gaps).
      const problems = (await measureV2Layout(page, { root: "main.k2-ui", skip: ".k2b-field, [data-ai-model-card]" })).problems;
      expect({ path, width, problems }).toEqual({ path, width, problems: [] });
      expect(await page.locator('main [data-k2-part="Loading"], main [aria-busy="true"]').count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  expect(errors).toEqual([]);
}, 300_000);

// k2b-ui gap: virtual Table (MW, #4211); until it lands a list that can grow shows its first 100 rows and a search.
test("a provider with 1,000 models is ready at once with its first 100, a search in the address, and every model reachable", async () => {
  // the rows of the provider's models table ("1003 models"), not those of the providers beside it
  const rows = () =>
    main()
      .getByRole("table", { name: /\d+ models?$/ })
      .locator("tbody tr");
  const timed = async (query: string) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const started = performance.now();
    await page.goto(`${fixture.url}?locale=en&${query}`);
    await page.locator('main.k2-ui[data-ready="true"]').waitFor();
    const took = performance.now() - started;
    console.info(JSON.stringify({ ready: query, ms: Math.round(took) }));
    return took;
  };
  expect(await timed("sec=providers&p=cortecs&state=worst")).toBeLessThan(1500);
  expect(await rows().count()).toBeLessThanOrEqual(100);
  // the fixture's three Cortecs models and the 1,000 of the worst case, counted in the page's locale
  expect(await main().getByText("100 of 1,003 · Narrow the search").isVisible()).toBe(true);
  expect((await measureV2Layout(page, { root: "main.k2-ui" })).problems).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // the search lives in the address: Enter sends `mq`, the model beyond the first hundred shows, and its link keeps it
  const search = main().getByRole("searchbox", { name: "Search this provider’s models" });
  await search.fill("Modell 999");
  await search.press("Enter");
  await page.waitForURL(/mq=Modell\+999/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(await rows().count()).toBe(1);
  expect(
    await main()
      .getByRole("link", { name: /Modell 999/ })
      .first()
      .getAttribute("href"),
  ).toBe("/admin/ai?sec=providers&p=cortecs&m=bulk-999&mq=Modell+999");
  expect(
    await main()
      .getByText(/ of .* · Narrow the search/)
      .count(),
  ).toBe(0);

  // an open model beyond the first hundred is its own address: its detail opens without its row, and the list stays capped
  expect(await timed("sec=providers&p=cortecs&m=bulk-998&state=worst")).toBeLessThan(1500);
  expect(await page.getByRole("textbox", { name: /^Display name/ }).inputValue()).toBe("Modell 998");
  expect(await rows().count()).toBeLessThanOrEqual(100);

  // the dialog that adds models shows the first 100 of what the provider offers, and its search reaches the rest
  await timed("sec=providers&p=cortecs&state=worst");
  await button("Add models").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("100 of 1,000 · Narrow the search").waitFor();
  expect(await dialog.getByRole("checkbox").count()).toBeLessThanOrEqual(100);
  await dialog.getByRole("searchbox").fill("Angebot 999");
  expect(await dialog.getByRole("checkbox", { name: /Angebot 999/ }).count()).toBe(1);

  await page.goto(`${fixture.url}?locale=de&sec=providers&p=cortecs&state=worst`);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(await main().getByText("100 von 1.003 · Suche eingrenzen").isVisible()).toBe(true);
  expect(errors).toEqual([]);
});

test("the AI sections stand under their entry in the admin bar, and an open provider and model live in the address", async () => {
  await goto("sec=providers");
  const nav = page.getByRole("navigation", { name: "Administration" });
  expect(await nav.locator('[aria-current="page"]').innerText()).toBe("Providers");
  await main()
    .getByRole("link", { name: /Cortecs/ })
    .first()
    .click();
  await page.waitForURL(/p=cortecs/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();
  expect(
    await main()
      .getByRole("link", { name: /GPT-OSS/ })
      .first()
      .isVisible(),
  ).toBe(true);
  const model = main()
    .getByRole("link", { name: /GPT-OSS/ })
    .first();
  expect(await model.getAttribute("href")).toBe("/admin/ai?sec=providers&p=cortecs&m=gpt-oss-120b");
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b");
  expect(await page.getByRole("textbox", { name: /^Display name/ }).inputValue()).toBe("GPT-OSS");
  // on the phone the open model is the page, with the way back to its provider
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b", 390);
  const back = main().getByRole("link", { name: "Cortecs" }).filter({ visible: true }).first();
  expect(await back.getAttribute("href")).toBe("/admin/ai?sec=providers&p=cortecs");
  expect(errors).toEqual([]);
});

test("a class takes its model from the chooser, saves with its revision and shows the new choice", async () => {
  await goto("sec=classes&slot=fast");
  await chooser().click();
  await page
    .getByRole("menuitemradio", { name: /Claude/ })
    .first()
    .click();
  await page.waitForURL(/slot=fast/);
  const put = fixture.requests.find((request) => request.method === "PUT" && request.path === "/api/admin/core/ai/assignments/fast");
  expect(put?.body).toEqual({ revision: 2, variantId: "claude" });
  expect(errors).toEqual([]);
});

test("provider conflicts render, merge and discard without reading a cleared accessor", async () => {
  const provider = {
    ...catalog.providers[0]!,
    revision: 4,
    models: catalog.models.filter((entry) => entry.providerId === "cortecs"),
    baseUrl: "https://new.example.org/v1",
  };
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/providers/cortecs", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, conflict(provider), 409);
  });
  await goto("sec=providers&p=cortecs&pane=conn");
  await page.getByRole("textbox", { name: /^Name/ }).fill("My connection");
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  await button("Discard my changes").click();
  expect(await page.getByRole("textbox", { name: /^Name/ }).inputValue()).toBe(provider.label);
  expect(await page.getByRole("textbox", { name: /^Base URL/ }).inputValue()).toBe(provider.baseUrl);
  expect(requests[1]).toEqual(expect.objectContaining({ revision: 4, label: "My connection", baseUrl: provider.baseUrl }));
});

test.each([false, true])("model merges forward hidden cache prices for server normalization (lower input=%s)", async (lowerInput) => {
  const model = catalog.models[0]!;
  const theirs = {
    ...model,
    revision: 4,
    enabled: false,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.015 },
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
  if (lowerInput) await page.getByRole("spinbutton", { name: "Input", exact: true }).fill("0.01");
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ label: "My model", enabled: false, icon: theirs.icon, revision: 4 }));
  expect(requests[1]).not.toHaveProperty("access");
  expect(requests[1]).toEqual(
    expect.objectContaining({ pricing: { ...theirs.pricing, inputPerMillion: lowerInput ? 0.01 : theirs.pricing.inputPerMillion } }),
  );
  await button("Discard my changes").click();
  expect(await page.getByRole("textbox", { name: /^Display name/ }).inputValue()).toBe(model.label);
});

test.each(["model", "variant"] as const)("price errors stay in the server validation path (%s)", async (kind) => {
  const requests: unknown[] = [];
  const model = catalog.models[0]!;
  const variant = catalog.variants[2]!;
  const path = kind === "model" ? `models/${model.id}` : `variants/${variant.id}`;
  await page.route(`**/api/admin/core/ai/${path}`, async (route) => {
    if (route.request().method() === "GET") return route.fallback();
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Invalid reference price." }, 400);
  });
  await goto(`sec=providers&p=cortecs&m=${model.id}`);
  if (kind === "variant") {
    await openVariant("Schnell");
    const dialog = page.getByRole("dialog");
    await flip(dialog, "Own prices");
    await dialog.getByRole("spinbutton", { name: "Input", exact: true }).fill("1000001");
    await dialog.getByRole("spinbutton", { name: "Output", exact: true }).fill("3");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
  } else {
    await page.getByRole("spinbutton", { name: "Input", exact: true }).fill("1000001");
    await save();
  }
  await page.getByText("Invalid reference price.", { exact: true }).waitFor();
  expect(requests).toEqual([expect.objectContaining({ pricing: expect.objectContaining({ inputPerMillion: 1000001 }) })]);
});

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
  await main().getByRole("spinbutton").first().fill("15");
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({
      revision: 5,
      rules: [
        expect.objectContaining({ scope: "*", hours: 24, grants: [expect.objectContaining({ limit: 15 })] }),
        expect.objectContaining({ scope: "remote" }),
      ],
    }),
  );
});

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
  expect(await button("Save").first().isDisabled()).toBe(true);
  await goto("sec=budgets&rule=new&state=empty");
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ rules: [expect.objectContaining({ scope: "*", hours: 24 })] }));
});

test("partial provider creation retries only pending key and header writes", async () => {
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
  await button("Add provider").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio").first().check();
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT");
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Demo");
  await dialog.getByRole("textbox", { name: /^Base URL/ }).fill("https://demo.example.org/v1");
  await dialog.getByLabel(/^API key/).fill("fictional-key");
  await dialog.getByRole("button", { name: "Advanced" }).click();
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
});

test("empty model listing accepts a manual id and exposes a globally unique editable id", async () => {
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/providers/cortecs/models", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic rejection" }, 400);
  });
  await goto("sec=providers&p=cortecs&state=listempty");
  await button("Add models").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Enter a model ID manually").fill("vendor/gpt-oss-120b");
  await dialog.getByRole("button", { name: "Advanced" }).click();
  const id = dialog.getByLabel("Model ID · vendor/gpt-oss-120b", { exact: true });
  expect(await id.inputValue()).toBe("cortecs-vendor-gpt-oss-120b");
  await id.fill("custom-model");
  await dialog.getByRole("button", { name: /Add 1/ }).click();
  await dialog.getByText("Synthetic rejection", { exact: true }).waitFor();
  expect(requests).toEqual([[expect.objectContaining({ id: "custom-model", providerModel: "vendor/gpt-oss-120b" })]]);
});

test.each([false, true])("variant merge forwards price overrides for server normalization (lower input=%s)", async (lowerInput) => {
  const variant = catalog.variants[2]!;
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/variants/${variant.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(
      route,
      conflict({
        ...variant,
        revision: 4,
        hint: "Remote hint",
        pricing: { inputPerMillion: 2, outputPerMillion: 3, cacheReadPerMillion: 0.2 },
      }),
      409,
    );
  });
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b");
  await openVariant("Schnell");
  const dialog = page.getByRole("dialog");
  await flip(dialog, "Own prices");
  await dialog.getByRole("spinbutton", { name: "Input", exact: true }).fill(lowerInput ? "0.1" : "2");
  await dialog.getByRole("spinbutton", { name: "Output", exact: true }).fill("3");
  await flip(dialog, "Own output limit");
  await dialog.getByRole("spinbutton", { name: /^Max output/ }).fill("4000");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("button", { name: "Merge and save" }).click();
  await dialog.getByRole("button", { name: "Discard my changes" }).waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({
      revision: 4,
      pricing: { inputPerMillion: lowerInput ? 0.1 : 2, outputPerMillion: 3, cacheReadPerMillion: 0.2 },
      maxOutputTokens: 4000,
      hint: "Remote hint",
    }),
  );
  await dialog.getByRole("button", { name: "Discard my changes" }).click();
  expect(await dialog.getByRole("switch", { name: "Own prices", exact: true }).isChecked()).toBe(true);
});

test("detail failures, missing models and no selection have distinct recovery states", async () => {
  await goto("sec=providers&p=cortecs&m=gpt-oss-120b&state=detailfail");
  // the pane's back name on the phone repeats the title hidden; the visible one is the failure itself
  await page.getByText("AI settings could not be loaded", { exact: false }).filter({ visible: true }).first().waitFor();
  expect(await button(/^(Retry|Try again)$/).count()).toBeGreaterThan(0);
  await goto("sec=providers&p=cortecs&m=missing&state=detailempty");
  await page.getByText("This model no longer exists", { exact: true }).filter({ visible: true }).first().waitFor();
  await goto("sec=providers&p=cortecs");
  expect(await page.getByText("This model no longer exists", { exact: true }).count()).toBe(0);
});

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
        await button("Add provider").first().click();
        await page.getByRole("dialog").getByRole("radio").first().check();
        await page.getByRole("dialog").getByRole("textbox", { name: /^Name/ }).fill("Demo");
        await page
          .getByRole("dialog")
          .getByRole("textbox", { name: /^Base URL/ })
          .fill("https://demo.example.org/v1");
        await page.getByRole("dialog").getByRole("button", { name: "Save and choose models" }).click();
      } else if (kind === "models") {
        await goto("sec=providers&p=cortecs&state=listempty");
        await button("Add models").first().click();
        await page.getByRole("dialog").getByLabel("Enter a model ID manually").fill("demo");
        await page.getByRole("dialog").getByRole("button", { name: "Add 1 model", exact: true }).click();
      } else if (kind === "variant") {
        await goto("sec=providers&p=cortecs&m=gpt-oss-120b");
        await button("Add variant").click();
        await page.getByRole("dialog").getByRole("textbox", { name: /^Name/ }).fill("Demo");
        await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      } else {
        await goto("sec=providers&p=cortecs&m=mistral-small");
        await moreActions("Delete model");
        const selects = page.getByRole("dialog").getByRole("combobox");
        await selects.first().waitFor();
        for (const select of await selects.all()) {
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
  });
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
  await page.getByRole("radio", { name: "Provider mark", exact: true }).check();
  await button("Delete").first().click();
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  expect(requests[1]).toEqual(
    expect.objectContaining({ icon: { kind: "provider" }, label: "Remote name", access: { expectedRevision: 1, entries: [] } }),
  );
});

for (const area of ["provider", "budget"] as const) {
  test(`malformed ${area} conflict leaves a recoverable form instead of a stuck busy state`, async () => {
    await page.route(area === "provider" ? "**/api/admin/core/ai/providers/cortecs" : "**/api/admin/core/ai-quotas", (route) =>
      json(route, conflict({ invalid: true }), 409),
    );
    await goto(area === "provider" ? "sec=providers&p=cortecs&pane=conn" : "sec=budgets&rule=*");
    if (area === "provider") await page.getByRole("textbox", { name: /^Name/ }).fill("My connection");
    else await main().getByRole("spinbutton").first().fill("15");
    await save();
    await page.getByRole("alert").filter({ hasText: "Could not save" }).waitFor();
    expect(await button("Save").first().isDisabled()).toBe(false);
  });
}

test("delete offers only replacements that preserve every capability of the assigned source model", async () => {
  await goto("sec=providers&p=cortecs&m=mistral-small");
  await moreActions("Delete model");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: /Gemini Flash/ }).waitFor();
  expect(await page.getByRole("option", { name: /GPT-OSS/ }).count()).toBe(0);
  expect(await page.getByRole("option", { name: /Claude/ }).count()).toBe(0);
});

test("provider selection works with arrow keys and focuses the form on a phone without overflowing", async () => {
  await goto("sec=providers", 390);
  await button("Add provider").first().click();
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("radio").first().focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => document.activeElement?.tagName === "INPUT" && document.activeElement.getAttribute("type") !== "radio");
  expect(await dialog.getByRole("textbox", { name: /^Name/ }).getAttribute("placeholder")).toBe("OpenRouter");
});

test("provider technical messages stay separate from localized recovery copy", async () => {
  await goto("sec=providers&p=cortecs&pane=conn&state=unreachable");
  expect(await page.getByText("Keine Antwort nach 10 s.", { exact: false }).count()).toBe(0);
  await button("Technical details").click();
  expect(await page.getByText("Keine Antwort nach 10 s.", { exact: false }).last().isVisible()).toBe(true);
});

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
  await page.getByRole("radio", { name: "Only selected people and groups", exact: true }).check();
  await save();
  await button("Merge and save").click();
  await button("Discard my changes").waitFor();
  expect(requests[1]).toEqual(expect.objectContaining({ label: "Remote name", access: { expectedRevision: 1, entries: [] } }));
});

test("the boundary choice offers no privacy commitment without moving the test; that boundary stays fixed and apps-only", async () => {
  await page.route("**/api/admin/core/ai/providers", async (route) => {
    await json(route, { ...catalog.providers.find((entry) => entry.id === "gemini-api")!, id: "demo", revision: 1 });
  });
  await goto("sec=providers");
  await button("Add provider").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio").first().check();
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Gemini");
  await dialog.getByRole("textbox", { name: /^Base URL/ }).fill("https://generativelanguage.example.org/v1beta/openai/");
  const testButton = dialog.getByRole("button", { name: "Test connection" });
  await settled(page);
  const before = await testButton.boundingBox();
  await dialog.getByRole("radio", { name: "No privacy commitment" }).check();
  await dialog.getByText(/makes no data-protection commitment/).waitFor({ state: "visible" });
  expect(await testButton.boundingBox()).toEqual(before);
  await dialog.getByRole("radio", { name: "Hosted" }).check();
  await settled(page);
  expect(await testButton.boundingBox()).toEqual(before);
  await dialog.getByRole("radio", { name: "No privacy commitment" }).check();
  const created = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/api/admin/core/ai/providers"));
  await dialog.getByRole("button", { name: "Save and choose models" }).click();
  expect((await created).postDataJSON()).toEqual(expect.objectContaining({ dataBoundary: "restricted" }));
  // Saving reloads the area on the new provider; the next visit waits for that reload, or it aborts it.
  await page.waitForURL(/[?&]p=demo(&|$)/);
  await page.locator('main.k2-ui[data-ready="true"]').waitFor();

  await goto("sec=providers&p=gemini-api&pane=conn");
  await page.getByText("This boundary cannot change after creation", { exact: false }).waitFor();
  expect(await page.getByRole("radio", { name: "Hosted" }).count()).toBe(0);
  await goto("sec=providers&p=gemini-api&m=gemini-artikel");
  await page.getByText("Apps only.", { exact: false }).first().waitFor();
  expect(await page.getByRole("radio", { name: "All signed-in people" }).count()).toBe(0);
  await goto("sec=classes&slot=fast");
  await chooser().click();
  await page
    .getByRole("menuitemradio", { name: /GPT-OSS/ })
    .first()
    .waitFor();
  expect(await page.getByRole("menuitemradio", { name: /Gemini Artikeltexte/ }).count()).toBe(0);
});

test("manual decision models require context and retain the draft after a rejected save", async () => {
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/providers/cortecs/models", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic decision rejection" }, 400);
  });
  await goto("sec=providers&p=cortecs&state=listempty");
  await button("Add models").first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Enter a model ID manually").fill("cloudflare/clef");
  await dialog.getByRole("radio", { name: "Decision", exact: true }).check();
  await dialog.getByRole("button", { name: /Add 1/ }).click();
  expect(requests).toHaveLength(0);
  await dialog.getByLabel(/^Context window/).fill("32768");
  await dialog.getByRole("button", { name: /Add 1/ }).click();
  await dialog.getByText("Synthetic decision rejection", { exact: true }).waitFor();
  expect(requests).toEqual([
    [expect.objectContaining({ kind: "decision", providerModel: "cloudflare/clef", contextWindow: 32768, capabilities: [] })],
  ]);
  expect(await dialog.getByLabel("Enter a model ID manually").inputValue()).toBe("cloudflare/clef");
});

test("editing a decision model preserves vision and token prices while clearing chat parameters", async () => {
  const model = catalog.models[0]!;
  const requests: unknown[] = [];
  await page.route(`**/api/admin/core/ai/models/${model.id}`, async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic decision rejection" }, 400);
  });
  await goto(`sec=providers&p=${model.providerId}&m=${model.id}`);
  await page.getByRole("radio", { name: "Decision", exact: true }).check();
  const vision = page.getByLabel("Reads images directly", { exact: true });
  if (!(await vision.isChecked())) await vision.check();
  expect(await page.getByLabel(/^Context window/).isVisible()).toBe(true);
  expect(await page.getByLabel("Tools", { exact: true }).count()).toBe(0);
  await save();
  await page.getByText("Synthetic decision rejection", { exact: true }).waitFor();
  expect(requests).toEqual([
    expect.objectContaining({
      kind: "decision",
      capabilities: ["vision"],
      pricing: model.pricing,
      maxOutputTokens: null,
      extraBody: null,
      temperature: null,
    }),
  ]);
});

test("the decision class offers only decision models and preserves its address and choice after a failure", async () => {
  const requests: unknown[] = [];
  await page.route("**/api/admin/core/ai/assignments/decision", async (route) => {
    requests.push(route.request().postDataJSON());
    await json(route, { message: "Synthetic decision assignment rejection" }, 400);
  });
  await goto("sec=classes&slot=decision&state=decision");
  expect(new URL(page.url()).searchParams.get("slot")).toBe("decision");
  await chooser().click();
  expect(await page.getByRole("menuitemradio", { name: /gpt|mistral|whisper/i }).count()).toBe(0);
  await page.getByRole("menuitemradio", { name: /^Clef decision/ }).click();
  await page.getByText("Synthetic decision assignment rejection", { exact: true }).waitFor();
  expect(requests).toEqual([expect.objectContaining({ variantId: "clef" })]);
  expect(await main().locator('[data-k2-part="Facts"]').first().innerText()).toContain("Clef decision");
});

test("budgets lead with the cost of 30 days, and the switch in the head turns every rule off", async () => {
  await goto("sec=budgets");
  expect(await main().locator('[data-k2-part="Cells"]').first().innerText()).toContain("Cost, 30 days");
  const write = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith("/api/admin/core/ai-quotas"));
  await flip(main(), "On");
  expect((await write).postDataJSON()).toEqual(expect.objectContaining({ enabled: false, revision: 4 }));
});

for (const status of [403, 409, 500])
  test(`releasing the background brake names why HTTP ${status} refused it`, async () => {
    await page.route("**/api/admin/core/ai-quotas/background/release", (route) => json(route, { message: "test" }, status));
    await goto("sec=budgets&rule=brake&state=worst");
    await button("Release brake").click();
    await main()
      .getByText(status === 403 ? /do not have permission/ : status === 409 ? /unknown costs still prevent/ : /Please try again/)
      .first()
      .waitFor();
    expect(errors).toEqual([]);
  });

test("a new rule offers only priced active chat models, and a rule whose model left keeps its scope", async () => {
  await goto("sec=budgets&rule=new&state=empty");
  await main().getByRole("combobox").first().click();
  await page.getByRole("option", { name: "All models" }).waitFor();
  // Llama is disabled and unpriced, Whisper is audio: neither can carry a budget
  expect(await page.getByRole("option", { name: /Llama|Whisper/ }).count()).toBe(0);
  await page.keyboard.press("Escape");
  await goto("sec=budgets&rule=removed-model&state=orphan");
  expect(await main().getByRole("combobox").first().innerText()).toContain("removed-model");
  await main().getByRole("spinbutton").first().fill("12");
  expect(await button("Save").first().isDisabled()).toBe(false);
  expect(errors).toEqual([]);
});
