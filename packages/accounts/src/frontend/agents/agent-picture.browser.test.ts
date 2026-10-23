import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { profilePictureMessages } from "@k2b/cloud/account/ui";
import type { RobotAvatar } from "@k2b/cloud/contracts/avatar";
import { renderAvatarSvg } from "@k2b/cloud/shared";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import { accountsMessages } from "../messages";

// An agent always shows a robot or a photo. An administrator opens "Change profile picture" from the agent's page,
// which offers Photo and Robot, never a bare symbol, and saves through the administration API.
const root = mkdtempSync(join(tmpdir(), "accounts-agent-picture-browser-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const ui = resolve(import.meta.dir, "../../../../ui");
const origin = "https://cloud.example.test";
const AGENT = "0b2f5c7e-0000-4000-8000-0000000000bb";
const shots = process.env.CLOUD_PROFILE_PICTURE_SHOTS;
const robot: RobotAvatar = {
  v: 1,
  kind: "robot",
  head: "square",
  antenna: "ball",
  eyes: "round",
  mouth: "grill",
  body: "light",
  color: "teal",
  bg: "sand",
};

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AgentPicture.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-agent-picture-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Agent picture harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let css: string;
let harness: string;
// The shared Tabler preset, so icons such as the dialog's close button render as in Cloud.
let icons: { css: string; font: string };
beforeAll(async () => {
  harness = await buildHarness();
  const iconCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const iconCss = await Bun.file(fileURLToPath(iconCssUrl)).text();
  const fontAsset = iconCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  icons = { css: iconCss.replace(fontAsset, "/tabler-icons.woff2"), font: fileURLToPath(new URL(fontAsset, iconCssUrl)) };
  const styles = [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  if (shots) mkdirSync(shots, { recursive: true });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

type View = { width: number; height: number; touch: boolean; name: string };
const desktop: View = { width: 1440, height: 900, touch: false, name: "desktop" };
const phone: View = { width: 390, height: 844, touch: true, name: "phone" };
type State = { kind: "photo" | "built"; built: RobotAvatar; hasPhoto: boolean; photo: string | null; avatarHash: string | null };
type Api = { state: State; puts: unknown[]; fail: number };

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
    if (pathname === `/app/accounts/agents/${AGENT}`)
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          `<!doctype html><html lang="${lang}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<link rel="stylesheet" href="${origin}/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui"><div id="root" style="padding:24px"></div><script src="/harness.js"></script></body></html>`,
      });
    if (pathname === "/harness.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: harness });
    if (pathname === "/tabler-icons.css") return route.fulfill({ contentType: "text/css", body: icons.css });
    if (pathname === "/tabler-icons.woff2") return route.fulfill({ path: icons.font });
    if (pathname === `/api/admin/identity/service-accounts/${AGENT}/avatar`) {
      if (request.method() === "GET") return route.fulfill({ json: api.state });
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { built?: RobotAvatar; use?: "photo" | "built" };
        api.puts.push(body);
        if (api.fail > 0) {
          api.fail--;
          return route.fulfill({ status: 500, json: { message: "Internal server error" } });
        }
        api.state = body.built ? { ...api.state, kind: "built", built: body.built } : { ...api.state, kind: body.use ?? api.state.kind };
        return route.fulfill({ json: api.state });
      }
    }
    // The robot the page shows, as the avatar route serves it.
    if (pathname === `/api/accounts/users/${AGENT}/avatar`)
      return route.fulfill({ contentType: "image/svg+xml", body: renderAvatarSvg(api.state.built) });
    return route.fulfill({ status: 404, json: { message: "Not found" } });
  });
  await tab.goto(`${origin}/app/accounts/agents/${AGENT}`);
  await tab.evaluate(() => document.fonts.ready);
  return { context, tab };
};

const shoot = async (tab: Page, name: string) => {
  if (shots) await tab.screenshot({ path: join(shots, `agent-${name}.png`) });
};

describe("changing an agent's picture in a browser", () => {
  test("offers photo and robot, never a symbol, and saves a changed robot", async () => {
    for (const view of [desktop, phone]) {
      for (const lang of ["de", "en"] as const) {
        const t = profilePictureMessages.resolve([lang]).t;
        const api: Api = { state: { kind: "built", built: robot, hasPhoto: false, photo: null, avatarHash: null }, puts: [], fail: 0 };
        const { context, tab } = await open(view, lang, api);
        try {
          const trigger = tab.getByRole("button", { name: accountsMessages.resolve([lang]).t.agentChangePicture });
          // The page shows the agent's robot as a loaded picture in a square, never the fallback icon.
          const picture = trigger.locator(`img[src="/api/accounts/users/${AGENT}/avatar"]`);
          await tab.waitForFunction(
            (selector) => (document.querySelector<HTMLImageElement>(selector)?.naturalWidth ?? 0) > 0,
            `img[src="/api/accounts/users/${AGENT}/avatar"]`,
          );
          expect(await picture.getAttribute("data-shape")).toBe("square");
          expect(await trigger.locator("i.ti-robot").count()).toBe(0);
          await settled(tab);
          const pictureBox = await picture.boundingBox();
          expect([pictureBox?.width, pictureBox?.height]).toEqual([64, 64]);
          await trigger.click();
          const dialog = tab.locator("dialog[open]");
          const ways = dialog.getByRole("radiogroup", { name: t.ways });
          await ways.waitFor();
          expect(await ways.getByRole("radio").allTextContents()).toEqual([t.photo, `${t.robot}${t.active}`]);
          expect(await ways.getByRole("radio", { name: new RegExp(t.initials) }).count()).toBe(0);
          await dialog.getByText(t.visibleAgent).waitFor();
          await settled(tab);
          await shoot(tab, `${view.name}-${lang}-1-robot`);

          await dialog.getByRole("tab", { name: t.antenna }).click();
          await dialog.getByRole("radio", { name: t.option({ part: "antenna", id: "double" }) }).click();
          await dialog.getByRole("tab", { name: t.colours }).click();
          await dialog
            .getByRole("radiogroup", { name: t.casing })
            .getByRole("radio", { name: t.option({ part: "color", id: "coral" }) })
            .click();
          await dialog.getByText(t.unsaved).waitFor();
          await settled(tab);
          await shoot(tab, `${view.name}-${lang}-2-changed`);
          await dialog.getByRole("button", { name: t.save }).click();
          await dialog.waitFor({ state: "detached" });
          expect(api.puts).toEqual([{ built: { ...robot, antenna: "double", color: "coral" } }]);
        } finally {
          await context.close();
        }
      }
    }
  }, 180_000);

  test("keeps the robot when saving fails and saves on retry", async () => {
    const t = profilePictureMessages.resolve(["de"]).t;
    const api: Api = { state: { kind: "built", built: robot, hasPhoto: false, photo: null, avatarHash: null }, puts: [], fail: 1 };
    const { context, tab } = await open(phone, "de", api);
    try {
      await tab.getByRole("button", { name: accountsMessages.resolve(["de"]).t.agentChangePicture }).click();
      const dialog = tab.locator("dialog[open]");
      await dialog.getByRole("button", { name: t.random }).click();
      await dialog.getByRole("button", { name: t.save }).click();
      await dialog.getByText(t.saveFailed).waitFor();
      await shoot(tab, "phone-de-3-save-failed");
      await dialog.getByRole("button", { name: t.retry }).click();
      await dialog.waitFor({ state: "detached" });
      expect(api.puts).toHaveLength(2);
      expect(api.puts[0]).toEqual(api.puts[1]);
    } finally {
      await context.close();
    }
  }, 60_000);
});
