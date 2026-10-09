import { describe, expect, test } from "bun:test";
import { type AuthorizationState, authorizationStates, renderAuthorizationState, sample } from "./authorization-page.test-fixture";

/** The visible text of the page body, with tags removed and whitespace collapsed. */
const text = (html: string) =>
  /<body[^>]*>([\s\S]*)<\/body>/
    .exec(html)![1]!
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

const title = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const heading = (html: string) => /<h1 id="oauth-page-title"[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];

describe("OAuth authorization pages", () => {
  test("every state is one centered card on the minimal layout, without Cloud chrome", async () => {
    for (const state of Object.keys(authorizationStates) as AuthorizationState[]) {
      for (const locale of ["en", "de"] as const) {
        const html = await renderAuthorizationState(state, locale);
        const context = `${state} ${locale}`;
        expect(html, context).toContain(`<html lang="${locale}"`);
        expect(count(html, /<main\b/g), context).toBe(1);
        expect(html, context).toContain('aria-labelledby="oauth-page-title"');
        expect(html, context).toContain("standalone-card");
        expect(count(html, /<h1\b/g), context).toBe(1);
        expect(html, context).toContain('<h1 id="oauth-page-title"');
        expect(html, context).toContain('<footer class="minimal-layout-footer">');
        // The only navigation is the footer's legal links.
        expect(count(html, /<nav\b/g), context).toBe(1);
        // No tinted icon tile and no yellow notice box.
        expect(html, context).not.toContain("k2b-notice");
        expect(html, context).not.toMatch(/bg-(blue|emerald|amber|red)-100/);
      }
    }
  });

  test("the device confirmation shows the code, the client, every scope and the own-sign-in warning in English", async () => {
    const html = await renderAuthorizationState("confirm", "en");
    const body = text(html);
    expect(html).toContain("<title>Connect a device");
    expect(body).toContain("Allow Cloud CLI to access your account?");
    expect(html).toMatch(new RegExp(`data-testid="device-user-code"[^>]*>${sample.code}<`));
    expect(body).toContain("Check that this code matches the one on your device");
    expect(body).toContain("Client ID");
    expect(body).toContain(sample.cli.clientId);
    for (const scope of [
      "Identify your Cloud account",
      "Read data and Help available to your account",
      "Perform changes available to your account",
      "Stay connected until you revoke access",
    ])
      expect(body).toContain(scope);
    expect(body).toContain("Only continue if you started this sign-in yourself.");
    expect(body).toContain("Cloud permissions still limit");
    expect(html).toContain('<form method="post" action="/oauth/device"');
    expect(html).toContain(`<input type="hidden" name="request" value="${sample.request}"`);
    // Deny first, Allow last and primary.
    expect(html).toMatch(/value="deny"[^>]*data-variant="secondary"[\s\S]*value="approve"[^>]*data-variant="primary"/);
    expect(body).toMatch(/Deny .*Allow access/);
  });

  test("the device confirmation and the consent page read naturally in German", async () => {
    const confirm = text(await renderAuthorizationState("confirm", "de"));
    expect(confirm).toContain("Cloud CLI Zugriff auf dein Konto erlauben?");
    expect(confirm).toContain("Prüfe, ob dieser Code mit dem auf deinem Gerät übereinstimmt");
    expect(confirm).toContain("Client-ID");
    expect(confirm).toContain("Fahre nur fort, wenn du diese Anmeldung selbst gestartet hast.");
    expect(confirm).toMatch(/Ablehnen .*Zugriff erlauben/);

    const html = await renderAuthorizationState("consent", "de");
    const consent = text(html);
    expect(html).toContain("<title>Anwendung autorisieren");
    expect(consent).toContain(`${sample.dynamic.name} autorisieren`);
    expect(consent).toContain("Rückkehr zu localhost:53682");
    expect(consent).toContain("Ressource https://cloud.example/api/mcp/v1");
    expect(consent).toContain(`Client-ID ${sample.dynamic.clientId}`);
    expect(consent).toContain("Für dein Konto verfügbare Änderungen ausführen");
    expect(consent).toContain("nicht verifiziert");
    expect(html).toContain('<form method="post" action="/oauth/consent"');
    expect(consent).toMatch(/Ablehnen .*Zugriff erlauben/);
  });

  test("code entry is a plain GET form in both languages", async () => {
    for (const [locale, title, button] of [
      ["en", "Connect a device", "Continue"],
      ["de", "Gerät verbinden", "Weiter"],
    ] as const) {
      const html = await renderAuthorizationState("entry", locale);
      expect(text(html)).toContain(title);
      expect(text(html)).toContain(button);
      expect(html).toContain('<form method="get" action="/oauth/device"');
      expect(html).toContain('name="user_code"');
    }
  });

  test("approval ends on a status that says the tab can be closed", async () => {
    for (const [locale, title, body] of [
      ["en", "Device connected", "You can close this tab now."],
      ["de", "Gerät verbunden", "Du kannst diesen Tab jetzt schließen."],
    ] as const) {
      const html = await renderAuthorizationState("approved", locale);
      expect(html).toMatch(new RegExp(`role="status"[\\s\\S]*<h1 id="oauth-page-title"[^>]*>${title}</h1>`));
      expect(text(html)).toContain(body);
      expect(html).not.toContain("<form");
    }
  });

  test("denied, expired and failed requests end calmly with what to do next", async () => {
    const denied = await renderAuthorizationState("denied", "de");
    expect(denied).toContain('role="status"');
    expect(text(denied)).toContain("Zugriff abgelehnt");
    expect(text(denied)).toContain("Das Gerät wurde nicht verbunden. Du kannst diesen Tab jetzt schließen.");

    const expired = await renderAuthorizationState("expired", "en");
    expect(expired).toContain('role="status"');
    expect(text(expired)).toContain("Request no longer valid");
    expect(expired).toMatch(/<a href="\/oauth\/device"[^>]*>[\s\S]*Enter another code/);

    const failed = await renderAuthorizationState("error", "en");
    expect(failed).toContain('role="status"');
    expect(failed).toContain("<title>Authorization error");
    expect(text(failed)).toContain("Authorization failed");
    expect(text(failed)).toContain("Your account is not allowed to use this application.");
    expect(text(failed)).toContain("Error code: access_denied");
    expect(failed).toMatch(/<a href="\/"[^>]*>[\s\S]*Back to home/);

    const blocked = await renderAuthorizationState("blocked", "en");
    expect(blocked).toContain('role="status"');
    expect(text(blocked)).toContain("Authorization failed");
    expect(text(blocked)).toContain("The mobile app cannot grant access to other applications.");
    expect(blocked).not.toContain("<form");
  });

  test("the tab names the task until the request has an answer, then the answer", async () => {
    for (const locale of ["en", "de"] as const) {
      const entry = await renderAuthorizationState("entry", locale);
      expect(title(entry), locale).toBe(locale === "en" ? "Connect a device" : "Gerät verbinden");
      for (const state of ["approved", "denied", "expired", "blocked"] as const) {
        const html = await renderAuthorizationState(state, locale);
        expect(heading(html), `${state} ${locale}`).toBeString();
        expect(title(html), `${state} ${locale}`).toBe(heading(html));
      }
    }
  });
});
