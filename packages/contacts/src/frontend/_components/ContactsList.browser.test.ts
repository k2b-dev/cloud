import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { appAccentStyle } from "../../../../cloud/src/ssr/app-appearance";
import { appColors } from "../../../../cloud/src/ssr/app-color";
import { appHostCss } from "../../../../ui/test/app-host-fixture";
import { launchBrowser, settled } from "../../../../ui/test/browser";
import type { Contact, ContactTreeNode } from "../../service";
import "./ssr-test-plugin";

const { default: ContactsList } = await import("./ContactsList");
const { default: ContactOrgTreeView } = await import("./ContactOrgTreeView");
const now = "2026-10-17T12:00:00.000Z";
const contact: Contact = {
  id: "ada",
  bookId: "team",
  label: null,
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: null,
  department: null,
  jobTitle: null,
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: now,
  updatedAt: now,
  emails: [{ id: "email-1", contactId: "ada", label: "Work", email: "ada@example.com", position: 0, createdAt: now, updatedAt: now }],
  phones: [{ id: "phone-1", contactId: "ada", label: "Work", phone: "+442079460958", position: 0, createdAt: now, updatedAt: now }],
  addresses: [],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
};

const node: ContactTreeNode = {
  id: contact.id,
  label: null,
  firstName: contact.firstName,
  lastName: contact.lastName,
  companyName: null,
  jobTitle: null,
  parentContactId: null,
  children: [],
};
const markup = (selected: boolean) =>
  `<div id="list">${renderToString(() =>
    createComponent(ContactsList, {
      contacts: [contact],
      initialSelectedContactId: selected ? contact.id : null,
      initialSelectedBookId: selected ? contact.bookId : null,
      detailBaseHref: "/app/contacts/team",
      initialFavoriteKeys: [],
    }),
  )}</div><div id="tree">${renderToString(() =>
    createComponent(ContactOrgTreeView, {
      tree: { bookId: contact.bookId, selectedId: selected ? contact.id : "", root: node },
      onSelect: () => {},
      onBack: () => {},
    }),
  )}</div>`;

let browser: Awaited<ReturnType<typeof launchBrowser>>;
let css: string;
let unselectedHtml: string;
let selectedHtml: string;
beforeAll(async () => {
  setSystemTime(new Date(now));
  try {
    unselectedHtml = markup(false);
    selectedHtml = markup(true);
  } finally {
    setSystemTime();
  }
  css = await appHostCss(resolve(import.meta.dir, "../../styles/app.css"));
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});
const rgb = (hex: string) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;
const luminance = (rgb: number[]) => {
  const channels = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};
const contrast = (ink: number[], fill: number[]) => {
  const first = luminance(ink),
    second = luminance(fill);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

for (const accent of ["#0f766e", "#eab308"] as const) {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    test(`Contacts selected list and org rows keep app colors, contrast and geometry (${accent}, ${viewport.width}px)`, async () => {
      const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(now));
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
          <body class="k2b-ui"><main id="scope" class="app-accent-scope" style="${appAccentStyle(accent)}"></main>
          <span id="platform" style="background:var(--k2b-selected)"></span></body></html>`);
        const unreadableAvatars: string[] = [];
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate(
            ({ theme, html }) => {
              document.documentElement.className = theme;
              document.querySelector("#scope")!.innerHTML = html;
            },
            { theme, html: unselectedHtml },
          );
          await settled(page);
          const before = await page.locator("#list a[data-contact-row], #tree button.group").evaluateAll((rows) =>
            rows.map((row) => {
              const { x, y, width, height } = row.getBoundingClientRect();
              return { x, y, width, height };
            }),
          );
          expect(before).toHaveLength(2);
          await page.locator("#scope").evaluate((scope, html) => {
            scope.innerHTML = html;
          }, selectedHtml);
          await settled(page);
          const rows = await page.locator('#list a[aria-current="true"], #tree button[aria-current="true"]').evaluateAll((rows) => {
            // Resolve currentColor/color-mix in sRGB and composite the avatar over its actual selected row.
            const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
            const composite = (...colors: string[]) => {
              canvas.clearRect(0, 0, 1, 1);
              for (const color of colors) {
                canvas.fillStyle = color;
                canvas.fillRect(0, 0, 1, 1);
              }
              return [...canvas.getImageData(0, 0, 1, 1).data.slice(0, 3)];
            };
            return rows.map((row) => {
              const style = getComputedStyle(row);
              const name = getComputedStyle(row.querySelector(".app-accent-text") ?? row);
              const avatar = getComputedStyle(row.querySelector(".contact-avatar")!);
              const { x, y, width, height } = row.getBoundingClientRect();
              return {
                box: { x, y, width, height },
                fill: style.backgroundColor,
                ink: name.color,
                platform: getComputedStyle(document.querySelector("#platform")!).backgroundColor,
                nameRgb: composite(name.color),
                fillRgb: composite(style.backgroundColor),
                avatarInk: composite(avatar.color),
                avatarFill: composite(style.backgroundColor, avatar.backgroundColor),
              };
            });
          });
          expect(rows).toHaveLength(2);
          expect(rows.map((row) => row.box)).toEqual(before);
          for (const [index, row] of rows.entries()) {
            const label = `${accent} ${theme} ${index === 0 ? "list" : "org"} ${viewport.width}px`;
            expect(row.fill, label).toBe(rgb(appColors(accent)[theme].selected));
            expect(row.fill, label).not.toBe(row.platform);
            expect(row.ink, label).toBe(rgb(appColors(accent)[theme].ink));
            const nameContrast = contrast(row.nameRgb, row.fillRgb);
            const avatarContrast = contrast(row.avatarInk, row.avatarFill);
            expect(nameContrast, label).toBeGreaterThanOrEqual(4.5);
            if (avatarContrast < 4.5) unreadableAvatars.push(`${label}: ${avatarContrast.toFixed(3)}:1 < 4.5:1`);
          }
        }
        expect(unreadableAvatars, "Avatar initials must reach 4.5:1 on the composited fill").toEqual([]);
      } finally {
        await context.close();
      }
    }, 30_000);
  }
}
