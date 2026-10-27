import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { profilePictureMessages } from "@k2b/cloud/account/ui";
import { type PersonAvatar, robotAvatarFromSeed } from "@k2b/cloud/contracts/avatar";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";

// "Change profile picture" on /me: a person picks a photo, a built avatar, or initials. The dialog keeps one size,
// saves in one step, keeps the choice when saving fails, and asks before it drops unsaved changes.
const root = mkdtempSync(join(tmpdir(), "core-profile-picture-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const { buildFontAssets } = await import("../../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../../scripts/tabler-assets");
const origin = "https://cloud.example.test";
// Optional review screenshots for the pull request; never written in CI.
const shots = process.env.CLOUD_PROFILE_PICTURE_SHOTS;

const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const mara: PersonAvatar = {
  v: 1,
  kind: "person",
  face: "oval",
  skin: "s2",
  hair: "bob",
  hairColor: "red",
  eyes: "ovals",
  brows: "arched",
  mouth: "smile",
  beard: "none",
  glasses: "round",
  head: "none",
  extra: "freckles",
  bg: "sky",
};

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ProfilePicture.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-profile-picture-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Profile picture harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
beforeAll(async () => {
  harness = await buildHarness();
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(join(root, "public"));
  await buildTablerIconAssets(join(root, "public"));
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const desktop: View = { width: 1440, height: 900, touch: false, name: "desktop" };
const phone: View = { width: 390, height: 844, touch: true, name: "phone" };

type State = {
  kind: "photo" | "built" | "initials";
  built: PersonAvatar | null;
  hasPhoto: boolean;
  photo: string | null;
  avatarHash: string | null;
};
/** `pages` counts document loads of /me, so a test can tell a real reload from a history step. */
type Api = {
  state: State;
  failPuts: number;
  puts: unknown[];
  deletes: number;
  pages?: number;
  holdPut?: Promise<void>;
  holdDelete?: Promise<void>;
};

const open = async (view: View, lang: "en" | "de", api: Api) => {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    deviceScaleFactor: 1,
    isMobile: view.touch,
    hasTouch: view.touch,
    reducedMotion: "reduce",
  });
  const tab = await context.newPage();
  await tab.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/me") {
      api.pages = (api.pages ?? 0) + 1;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
          `<body class="k2b-ui"><div id="root" style="padding:24px"></div><script src="/harness.js"></script></body></html>`,
      });
    }
    if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (pathname.startsWith("/public/")) return route.fulfill({ path: join(root, pathname) });
    if (pathname === "/api/me/avatar" && request.method() === "GET") return route.fulfill({ json: api.state });
    if (pathname === "/api/me/avatar" && request.method() === "PUT") {
      const body = request.postDataJSON() as { built?: PersonAvatar; use?: State["kind"] };
      api.puts.push(body);
      await api.holdPut;
      if (api.failPuts > 0) {
        api.failPuts--;
        return route.fulfill({ status: 500, json: { message: "Internal server error" } });
      }
      api.state = body.built
        ? { ...api.state, kind: "built", built: body.built, avatarHash: "a".repeat(64) }
        : { ...api.state, kind: body.use ?? api.state.kind };
      return route.fulfill({ json: { message: "Avatar updated.", ...api.state } });
    }
    if (pathname === "/api/me/avatar" && request.method() === "DELETE") {
      api.deletes++;
      await api.holdDelete;
      api.state = { ...api.state, hasPhoto: false, photo: null, kind: api.state.kind === "photo" ? "initials" : api.state.kind };
      return route.fulfill({ json: { message: "Avatar deleted." } });
    }
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}/me`);
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const initials = (): Api => ({
  state: { kind: "initials", built: null, hasPhoto: false, photo: null, avatarHash: null },
  failPuts: 0,
  puts: [],
  deletes: 0,
});

const openDialog = async (tab: Page, lang: "en" | "de") => {
  await tab.locator("button[aria-haspopup], button[title]").first().click();
  const dialog = tab.locator("dialog[open]");
  await dialog.getByRole("radiogroup", { name: profilePictureMessages.resolve([lang]).t.ways }).waitFor();
  return dialog;
};

/** Waits for a condition the test's own fake API records, with a bounded deadline. */
const waitUntil = async (check: () => boolean, what: string) => {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
};

const shoot = async (tab: Page, name: string) => {
  if (!shots) return;
  await tab.screenshot({ path: join(shots, `${name}.png`) });
};

describe("changing the profile picture in a browser", () => {
  test("draws the same avatars and seeded robots as the server", async () => {
    const { context, tab } = await open(desktop, "en", initials());
    try {
      const drawn = await tab.evaluate(
        ({ config }) => {
          const art = (
            window as unknown as { avatarArt: { renderAvatarSvg: (c: unknown) => string; robotAvatarFromSeed: (s: string) => unknown } }
          ).avatarArt;
          return { svg: art.renderAvatarSvg(config), robots: ["agent-0", "Ünïcødé 🤖"].map((seed) => art.robotAvatarFromSeed(seed)) };
        },
        { config: mara },
      );
      expect(drawn.svg).toBe(renderAvatarSvg(mara));
      expect(drawn.robots).toEqual([robotAvatarFromSeed("agent-0"), robotAvatarFromSeed("Ünïcødé 🤖")]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("opens on a first draft, keeps one size, and saves the built avatar in one step", async () => {
    for (const view of [desktop, phone]) {
      for (const lang of ["de", "en"] as const) {
        const t = profilePictureMessages.resolve([lang]).t;
        const api = initials();
        const { context, tab } = await open(view, lang, api);
        try {
          const dialog = await openDialog(tab, lang);
          const ways = dialog.getByRole("radiogroup", { name: t.ways });
          expect(await ways.getByRole("radio", { name: new RegExp(t.avatar) }).getAttribute("aria-checked")).toBe("true");
          expect(await ways.getByRole("radio", { name: new RegExp(t.initials) }).textContent()).toContain(t.active);
          await dialog.getByText(t.visiblePerson).waitFor();
          const frame = async () =>
            dialog.evaluate((element) => {
              const box = element.getBoundingClientRect();
              const save = element.querySelector(".cloud-profile-picture__save")!.getBoundingClientRect();
              return {
                width: Math.round(box.width),
                height: Math.round(box.height),
                saveTop: Math.round(save.top),
                saveLeft: Math.round(save.left),
              };
            });
          await settled(tab);
          const before = await frame();
          if (view === phone) expect([before.width, before.height]).toEqual([view.width, view.height]);
          else expect([before.width, before.height]).toEqual([1080, 700]);
          await shoot(tab, `${view.name}-${lang}-1-first-draft`);

          await dialog.getByRole("tab", { name: t.hair }).click();
          const hairstyles = dialog.getByRole("radiogroup", { name: t.hairstyle });
          // Fail directly if the harness no longer starts on the draft that exposed this regression.
          expect(await hairstyles.getByRole("radio", { name: t.option({ part: "hair", id: "afro" }) }).getAttribute("aria-checked")).toBe(
            "true",
          );
          expect(
            await dialog
              .getByRole("radiogroup", { name: t.hairColor })
              .getByRole("radio", { name: t.option({ part: "hairColor", id: "red" }) })
              .getAttribute("aria-checked"),
          ).toBe("true");
          await hairstyles.getByRole("radio", { name: t.option({ part: "hair", id: "curly" }) }).click();
          await hairstyles.getByRole("radio", { name: t.option({ part: "hair", id: "curly" }) }).press("ArrowRight");
          expect(await hairstyles.getByRole("radio", { name: t.option({ part: "hair", id: "afro" }) }).getAttribute("aria-checked")).toBe(
            "true",
          );
          await dialog
            .getByRole("radiogroup", { name: t.hairColor })
            .getByRole("radio", { name: t.option({ part: "hairColor", id: "red" }) })
            .click();
          // Returning to the seeded first draft is not an edit.
          await dialog.getByText(t.visiblePerson).waitFor();
          // Switching parts or ways never resizes the frame or moves the save button.
          await dialog.getByRole("tab", { name: t.glasses }).click();
          await dialog
            .getByRole("radiogroup", { name: t.glasses })
            .getByRole("radio", { name: t.option({ part: "glasses", id: "round" }) })
            .click();
          await dialog.getByText(t.unsaved).waitFor();
          await settled(tab);
          expect(await frame()).toEqual(before);
          await shoot(tab, `${view.name}-${lang}-2-hair`);

          const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          expect(overflow).toBeLessThanOrEqual(0);
          // A save reloads the page, so the header, rail, and lists show the new picture.
          await dialog.getByRole("button", { name: t.save }).click();
          await waitUntil(() => api.pages === 2, "the page to reload");
          expect(api.puts).toHaveLength(1);
          expect(api.puts[0]).toMatchObject({ built: { kind: "person", hair: "afro", hairColor: "red", glasses: "round" } });
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);

  test("saves an untouched first draft, because it is not stored yet", async () => {
    const t = profilePictureMessages.resolve(["en"]).t;
    const api = initials();
    const { context, tab } = await open(desktop, "en", api);
    try {
      const dialog = await openDialog(tab, "en");
      await dialog.getByRole("button", { name: t.save }).click();
      await waitUntil(() => api.puts.length === 1, "the save");
      expect(api.puts[0]).toMatchObject({ built: { kind: "person" } });
    } finally {
      await context.close();
    }
  }, 30_000);

  test("on a phone, a failed save keeps Cancel and Save where they were", async () => {
    for (const lang of ["de", "en"] as const) {
      const t = profilePictureMessages.resolve([lang]).t;
      const api: Api = { ...initials(), failPuts: 1 };
      const { context, tab } = await open(phone, lang, api);
      try {
        const dialog = await openDialog(tab, lang);
        const save = dialog.locator(".cloud-profile-picture__save");
        await settled(tab);
        const before = await save.boundingBox();
        await save.click();
        await dialog.getByText(t.saveFailed).waitFor();
        await settled(tab);
        expect(await save.boundingBox()).toEqual(before);
        await shoot(tab, `phone-${lang}-9-save-failed`);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("keeps every kind mounted, so a photo's crop or a draft survives a look at another kind", async () => {
    const t = profilePictureMessages.resolve(["en"]).t;
    const api: Api = { ...initials(), state: { kind: "built", built: mara, hasPhoto: true, photo: PHOTO, avatarHash: "b".repeat(64) } };
    const { context, tab } = await open(desktop, "en", api);
    try {
      const dialog = await openDialog(tab, "en");
      await dialog.getByRole("radio", { name: new RegExp(t.photo) }).click();
      await dialog.getByText(t.photoHidden).waitFor();
      const pane = await dialog.locator(".cloud-profile-picture__pane").filter({ hasText: t.photoHidden }).elementHandle();
      await dialog.getByRole("radio", { name: new RegExp(t.avatar) }).click();
      await dialog.getByRole("tab", { name: t.glasses }).waitFor();
      await dialog.getByRole("radio", { name: new RegExp(t.photo) }).click();
      await dialog.getByText(t.photoHidden).waitFor();
      // The same photo pane as before, where a cropper would keep its crop, not a new one.
      expect(
        await dialog
          .locator(".cloud-profile-picture__pane")
          .filter({ hasText: t.photoHidden })
          .evaluate((element, earlier) => element === earlier, pane),
      ).toBe(true);
      expect(api.puts).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("keeps the choice when saving fails and saves again on retry without moving the buttons", async () => {
    const t = profilePictureMessages.resolve(["de"]).t;
    let release: () => void = () => {};
    const api: Api = {
      state: { kind: "built", built: mara, hasPhoto: false, photo: null, avatarHash: "b".repeat(64) },
      failPuts: 1,
      puts: [],
      deletes: 0,
      holdPut: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { context, tab } = await open(desktop, "de", api);
    try {
      const dialog = await openDialog(tab, "de");
      await dialog.getByRole("tab", { name: t.glasses }).click();
      await dialog.getByRole("radio", { name: t.option({ part: "glasses", id: "sun" }) }).click();
      const save = dialog.locator(".cloud-profile-picture__save");
      await settled(tab);
      const box = await save.boundingBox();
      await save.click();
      await dialog.getByText(t.saving).waitFor();
      expect(await save.boundingBox()).toEqual(box);
      await shoot(tab, "desktop-de-3-saving");
      release();
      await dialog.getByText(t.saveFailed).waitFor();
      expect(await save.boundingBox()).toEqual(box);
      expect(await dialog.getByRole("radio", { name: t.option({ part: "glasses", id: "sun" }) }).getAttribute("aria-checked")).toBe("true");
      await shoot(tab, "desktop-de-4-save-failed");
      await dialog.getByRole("button", { name: t.retry }).click();
      await waitUntil(() => api.pages === 2, "the page to reload");
      expect(api.puts).toEqual([{ built: { ...mara, glasses: "sun" } }, { built: { ...mara, glasses: "sun" } }]);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("asks before it drops unsaved changes and saves nothing when they are dropped", async () => {
    for (const view of [desktop, phone]) {
      const t = profilePictureMessages.resolve(["de"]).t;
      const api: Api = { ...initials(), state: { kind: "built", built: mara, hasPhoto: false, photo: null, avatarHash: "b".repeat(64) } };
      const { context, tab } = await open(view, "de", api);
      try {
        const dialog = await openDialog(tab, "de");
        await dialog.getByRole("button", { name: t.random }).click();
        await tab.keyboard.press("Escape");
        await tab.getByText(t.discardBody).waitFor();
        await shoot(tab, `${view.name}-de-5-discard`);
        await tab.getByRole("button", { name: t.discardCancel }).click();
        await dialog.getByRole("radiogroup", { name: t.ways }).waitFor();
        await dialog.getByRole("button", { name: t.cancel }).click();
        await tab.getByRole("button", { name: t.discardConfirm }).click();
        await tab.locator("dialog[open]").waitFor({ state: "detached" });
        expect(api.puts).toEqual([]);
      } finally {
        await context.close();
      }
    }
  }, 60_000);

  test("shows a stored photo that is not active and deletes it", async () => {
    const t = profilePictureMessages.resolve(["de"]).t;
    const api: Api = { ...initials(), state: { kind: "built", built: mara, hasPhoto: true, photo: PHOTO, avatarHash: "b".repeat(64) } };
    const { context, tab } = await open(phone, "de", api);
    try {
      const dialog = await openDialog(tab, "de");
      await dialog.getByRole("radio", { name: new RegExp(t.photo) }).click();
      await dialog.getByText(t.photoHidden).waitFor();
      await shoot(tab, "phone-de-6-photo-stored");
      await dialog.getByRole("button", { name: t.photoDelete }).click();
      await dialog.getByText(t.photoDrop).waitFor();
      expect(api.deletes).toBe(1);
      // Without a photo there is nothing to show: saving stays off until one is chosen.
      expect(await dialog.getByRole("button", { name: t.save }).isDisabled()).toBe(true);
      await dialog.getByRole("radio", { name: new RegExp(t.initials) }).click();
      await dialog.getByText(t.initialsInfo).waitFor();
      await shoot(tab, "phone-de-7-initials");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("holds still while a photo is being deleted and refreshes the page after closing", async () => {
    const t = profilePictureMessages.resolve(["en"]).t;
    let release: () => void = () => {};
    const api: Api = {
      ...initials(),
      state: { kind: "photo", built: null, hasPhoto: true, photo: PHOTO, avatarHash: "c".repeat(64) },
      holdDelete: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const { context, tab } = await open(desktop, "en", api);
    try {
      const dialog = await openDialog(tab, "en");
      await dialog.getByRole("button", { name: t.photoDelete }).click();
      await waitUntil(() => api.deletes === 1, "the deletion to start");
      // Closing and saving wait for the deletion; nothing else can change meanwhile.
      await tab.keyboard.press("Escape");
      expect(await dialog.getByRole("button", { name: t.save }).isDisabled()).toBe(true);
      expect(await dialog.getByRole("button", { name: t.cancel }).isDisabled()).toBe(true);
      expect(await tab.locator("dialog[open]").count()).toBe(1);
      release();
      await dialog.getByText(t.photoDrop).waitFor();
      await dialog.getByRole("button", { name: t.cancel }).click();
      await waitUntil(() => api.pages === 2, "the page to reload after the deletion");
      expect(api.puts).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30_000);

  test("shows why loading failed and loads again", async () => {
    const t = profilePictureMessages.resolve(["en"]).t;
    const api = initials();
    const { context, tab } = await open(desktop, "en", api);
    try {
      let failed = false;
      await tab.route(`${origin}/api/me/avatar`, async (route) => {
        if (route.request().method() === "GET" && !failed) {
          failed = true;
          return route.fulfill({ status: 503, json: { message: "Unavailable" } });
        }
        return route.fallback();
      });
      await tab.locator("button[title]").first().click();
      const dialog = tab.locator("dialog[open]");
      await dialog.getByText(t.loadFailed).waitFor();
      await shoot(tab, "desktop-en-8-load-failed");
      await dialog.getByRole("button", { name: t.retry }).click();
      await dialog.getByRole("radiogroup", { name: t.ways }).waitFor();
    } finally {
      await context.close();
    }
  }, 30_000);
});
