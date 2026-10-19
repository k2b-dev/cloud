import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { coreSettings, SIGN_IN_METHODS } from "@k2b/cloud/services";
import { prepareNotificationEmail } from "@k2b/cloud/services/notifications/email-frame";
import * as settingsStore from "@k2b/cloud/services/settings/store";
import { app } from "./config";

describe("Core notification definitions", () => {
  test("device enrollment is user-bound, required, and localized without credentials", async () => {
    const notice = app.notifications.deviceEnrollment;
    expect(notice.id).toBe("core.deviceEnrollment");
    expect(notice.recipient).toBe("user");
    expect(notice.delivery?.required).toEqual(["email"]);
    const de = await notice.render({ name: "Phone", assisted: true }, { locale: "de" });
    const en = await notice.render({ name: "Phone", assisted: false }, { locale: "en" });
    expect(de.body).toContain("Administrator");
    expect(en.title).toBe("New sign-in device linked");
    expect(de.targetHref).toBe("/me/security");
  });
  test("the new-phone notice is a personal preference: email first, browser where email is missing", () => {
    const notice = app.notifications.appDevicePaired;
    expect(notice.id).toBe("core.appDevicePaired");
    expect(notice.recipient).toBe("user");
    expect(notice.delivery).toEqual({ recommended: ["email", "browser"], required: [] });
    // The payload names the phone only; pairing codes, secrets and keys have no field to travel in.
    expect(Object.keys(notice.data.shape).sort()).toEqual(["name", "pairedAt", "platform"]);
  });
  test("keeps account expiry reminders required and user-bound", () => {
    const reminder = app.notifications.accountExpiryReminder;

    expect(reminder.id).toBe("core.accountExpiryReminder");
    expect(reminder.recipient).toBe("user");
    expect(reminder.delivery?.required).toEqual(["email"]);
  });
});

test("AI cost notifications format reference amounts in the recipient locale", async () => {
  const notice = app.notifications.backgroundCosts;
  const data = { kind: "warning" as const, cost: 1234.567891, unit: "Credits" };
  for (const [locale, amount] of [
    ["de", "1.234,567891"],
    ["en", "1,234.567891"],
  ]) {
    expect((await notice.render(data, { locale: locale! })).body).toContain(`${amount} Credits`);
    expect((await notice.email!(data, { locale: locale! })).content).toContain(`${amount} Credits`);
  }
});

test("pending approval notifications are browser-recommended, localized, and open the review page", async () => {
  const notice = app.notifications.approvalWaiting;
  expect(notice.id).toBe("core.approvalWaiting");
  expect(notice.recipient).toBe("user");
  expect(notice.delivery?.recommended).toEqual(["browser"]);
  expect(notice.data.safeParse({ count: 0 }).success).toBe(false);
  expect(notice.data.safeParse({ count: 1.5 }).success).toBe(false);
  expect(await notice.render({ count: 1 }, { locale: "en" })).toEqual({
    title: "Approval waiting",
    body: "An Action waits for your approval. Nothing happens until you decide.",
    targetHref: "/me/approvals",
  });
  expect((await notice.render({ count: 2 }, { locale: "en" })).title).toBe("2 approvals waiting");
  expect(await notice.render({ count: 1 }, { locale: "de" })).toEqual({
    title: "Freigabe wartet",
    body: "Eine Aktion wartet auf deine Freigabe. Bis du entscheidest, passiert nichts.",
    targetHref: "/me/approvals",
  });
  expect((await notice.render({ count: 2 }, { locale: "de" })).title).toBe("2 Freigaben warten");
  const url = spyOn(coreSettings, "get").mockResolvedValue("https://cloud.example.test/");
  try {
    const email = await notice.email!({ count: 2 }, { locale: "de" });
    expect(email.subject).toBe("2 Freigaben warten");
    expect(email.content).toContain("https://cloud.example.test/me/approvals");
    url.mockResolvedValue("cloud.example.test///");
    expect((await notice.email!({ count: 2 }, { locale: "en" })).content).toContain("https://cloud.example.test/me/approvals");
  } finally {
    url.mockRestore();
  }
});

describe("new-browser sign-in notice", () => {
  const now = new Date("2026-10-16T07:14:00.000Z");
  const data = {
    browser: "chrome" as const,
    os: "macos" as const,
    country: "AT",
    city: "Wien",
    signedInAt: now.toISOString(),
    method: "password" as const,
    device: null,
    firstName: "Jana",
  };
  const definition = app.notifications.newBrowserSignIn;
  let restore: () => void;
  beforeEach(() => {
    setSystemTime(now);
    const get = spyOn(settingsStore, "readKey").mockImplementation(async (key: string) => {
      const values: Record<string, unknown> = {
        "app.timezone": "Europe/Vienna",
        "app.url": "https://cloud.example.test/",
        "app.name": "Cloud",
        "app.logo": "",
      };
      if (!(key in values)) throw new Error(`Unexpected fixture setting: ${key}`);
      return values[key];
    });
    restore = () => get.mockRestore();
  });
  afterEach(() => {
    restore();
    setSystemTime();
  });

  test("is user-bound and optional, email first with browser fallback", () => {
    expect(definition.id).toBe("core.newBrowserSignIn");
    expect(definition.recipient).toBe("user");
    expect(definition.delivery).toEqual({ recommended: ["email", "browser"], required: [] });
    // Cloud bounds the greeting name to 100 characters before the handoff.
    expect(definition.data.safeParse({ ...data, firstName: "J".repeat(100) }).success).toBe(true);
  });

  for (const locale of ["de", "en"] as const) {
    test(`${locale}: full snapshot, with place confined to email`, async () => {
      const de = locale === "de";
      const title = de ? "Neue Anmeldung aus einem neuen Browser" : "New sign-in from a new browser";
      const time = de ? "16. Okt. 2026, 09:14 (Europe/Vienna)" : "Oct 16, 2026, 09:14 (Europe/Vienna)";
      const browser = de ? "Chrome auf macOS" : "Chrome on macOS";
      const rendered = await definition.render(data, { locale });
      expect(rendered).toEqual({ title, body: `${browser} · ${time}`, preview: `${browser} · ${time}`, targetHref: "/me/security" });
      expect(JSON.stringify(rendered)).not.toMatch(/Wien|Austria|Österreich/);
      const email = await definition.email!(data, { locale });
      expect(email.subject).toBe(title);
      const html = email.rawHtml!;
      for (const part of [
        de ? "Hallo Jana," : "Hi Jana,",
        de
          ? "dein Konto wurde gerade in einem Browser angemeldet, den Cloud noch nicht kannte."
          : "Your account was just signed in from a browser Cloud did not know yet.",
        browser,
        time,
        de ? "Ungefähr Wien, Österreich" : "Approximately Wien, Austria",
        de ? "Passwort" : "Password",
        de ? "Warst du das? Dann musst du nichts tun." : "Was this you? Then you don&#39;t need to do anything.",
        de
          ? "Falls du das nicht warst, prüfe unter <strong>Konto\u00a0› Anmeldung</strong> deine gekoppelten Geräte und wende dich an die Administration."
          : "If this wasn't you, check your paired devices under <strong>Account\u00a0› Sign-in</strong> and contact your administrator.",
        de ? "Anmeldung öffnen" : "Open sign-in",
        de
          ? "Diese Benachrichtigung kommt einmal pro neuem Browser. Du kannst sie unter Konto\u00a0› Benachrichtigungen abschalten."
          : "You get this notice once per new browser. You can turn it off under Account\u00a0› Notifications.",
        de ? "Ortsangaben sind ungefähr." : "Locations are approximate.",
        'href="https://cloud.example.test/me/security"',
      ])
        expect(html).toContain(part);
    });

    test(`${locale}: no GeoIP omits the entire location row and qualifier`, async () => {
      const html = (await definition.email!({ ...data, country: null, city: null, firstName: null }, { locale })).rawHtml!;
      expect(html).toContain(locale === "de" ? ">Hallo,</p>" : ">Hi,</p>");
      expect(html).not.toMatch(/Ungefähr|Approximately|Ortsangaben|Locations are approximate|>Ort<|>Location</);
      const countryOnly = (await definition.email!({ ...data, city: null }, { locale })).rawHtml!;
      expect(countryOnly).toContain(locale === "de" ? "Ungefähr Österreich" : "Approximately Austria");
    });

    test(`${locale}: all seven sign-in methods and escaped Cloud Login device`, async () => {
      const methods =
        locale === "de"
          ? [
              "Passwort",
              "Passkey",
              "E-Mail-Code",
              "Cloud Login, bestätigt auf „Janas Telefon“",
              "Passwort zurückgesetzt",
              "Abgelaufenes Passwort geändert",
              "Admin-Notfallzugang",
            ]
          : [
              "Password",
              "Passkey",
              "Email code",
              "Cloud Login, approved on “Janas Telefon”",
              "Password reset",
              "Expired password changed",
              "Emergency admin access",
            ];
      for (const [index, method] of SIGN_IN_METHODS.entries()) {
        expect((await definition.email!({ ...data, method, device: "Janas Telefon" }, { locale })).rawHtml).toContain(methods[index]!);
      }
      const malicious = `<Jana's "Phone">`;
      const email = await definition.email!(
        { ...data, method: "cloud_login", device: malicious, firstName: malicious, city: malicious },
        { locale },
      );
      expect(email.rawHtml).toContain("&lt;Jana&#39;s &quot;Phone&quot;&gt;");
      expect(email.rawHtml).not.toContain(malicious);
      const noDevice = (await definition.email!({ ...data, method: "cloud_login" }, { locale })).rawHtml!;
      expect(noDevice).toContain(">Cloud Login</td>");
    });
  }

  test("the email frame preserves the inset table, action href and inline styles", async () => {
    const email = await definition.email!(data, { locale: "en" });
    const prepared = await prepareNotificationEmail(email);
    expect(prepared.html).toContain('<table style="border:0;width:100%"');
    // The plain-text part keeps one line per detail and names the link target.
    expect(prepared.text).toContain("Browser: Chrome on macOS\nLocation: Approximately Wien, Austria\n");
    expect(prepared.text).toContain("Open sign-in: https://cloud.example.test/me/security");
    expect(prepared.text).not.toContain("<strong>");
    expect(prepared.html).toContain('href="https://cloud.example.test/me/security"');
    for (const style of [
      "background:#f4f4f5",
      "border-radius:10px",
      "padding:12px 16px",
      "white-space:nowrap",
      "font-weight:600",
      "display:inline-block",
      "background:#1d4ed8",
      "color:#ffffff",
      "padding:10px 18px",
      "border-radius:8px",
      "text-decoration:none",
    ])
      expect(prepared.html).toContain(style);
  });
});
