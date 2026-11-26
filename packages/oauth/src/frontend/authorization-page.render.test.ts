import { describe, expect, test } from "bun:test";
import {
  type AuthorizationState,
  authorizationStates,
  renderAuthorizationState,
  renderErrorPage,
  sample,
} from "./authorization-page.test-fixture";

/**
 * The visible text of the page body, without scripts, with tags as spaces and whitespace collapsed.
 * One handler, because an element keeps only the last end-tag handler registered for it.
 */
const text = (html: string) => {
  let inBody = false;
  let inScript = false;
  let visible = "";
  new HTMLRewriter()
    .on("*", {
      element(element) {
        visible += " ";
        if (!element.canHaveContent) return;
        if (element.tagName === "body") inBody = true;
        if (element.tagName === "script") inScript = true;
        element.onEndTag((end) => {
          visible += " ";
          if (end.name === "body") inBody = false;
          if (end.name === "script") inScript = false;
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (inBody && !inScript) visible += chunk.text;
      },
    })
    .transform(html);
  return visible.replace(/&amp;/g, "&").replace(/\s+/g, " ");
};

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;

const title = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1];
const heading = (html: string) => /<h1 class="k2-record-name"[^>]*>([^<]*)<\/h1>/.exec(html)?.[1];

/** The address of the first link whose words contain `words`. */
const linkTo = (html: string, words: string) => {
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!match[2]!.includes(words)) continue;
    return /href="([^"]*)"/.exec(match[1]!)?.[1]?.replaceAll("&amp;", "&");
  }
  return undefined;
};

/** The start tags of the buttons that send the form `form`, in document order. */
const submitButtons = (html: string, form: string) =>
  [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]).filter((tag) => tag.includes(`form="${form}"`));

describe("OAuth authorization pages", () => {
  test("end-session navigation asks for a POST and preserves the redirect for server validation", async () => {
    const html = await renderAuthorizationState("logout", "en");
    expect(text(html)).toContain("Sign out of Cloud in this browser?");
    expect(html).toMatch(
      /<form id="oauth-sign-out" method="post" action="\/oauth\/logout\?client_id=reference&amp;post_logout_redirect_uri=https%3A%2F%2Fclient.example%2Fsigned-out"/,
    );
    // the one button that sends it ends the session; staying signed in is a link that sends nothing
    expect(submitButtons(html, "oauth-sign-out")).toHaveLength(1);
    expect(submitButtons(html, "oauth-sign-out")[0]).toContain('type="submit"');
    expect(linkTo(html, "Stay signed in")).toBe("/");
  });

  test("every state is one v2 workspace on the minimal layout, without Cloud chrome", async () => {
    for (const state of Object.keys(authorizationStates) as AuthorizationState[]) {
      for (const locale of ["en", "de"] as const) {
        const html = await renderAuthorizationState(state, locale);
        const context = `${state} ${locale}`;
        expect(html, context).toContain(`<html lang="${locale}"`);
        expect(count(html, /<main\b/g), context).toBe(1);
        expect(html, context).toContain('data-k2-part="Workspace"');
        // the head names the task: the page's one heading
        expect(count(html, /<h1\b/g), context).toBe(1);
        expect(heading(html), context).toBeString();
        // the platform's footer (its look follows the Core that serves the page)
        expect(html, context).toContain('<footer class="minimal-layout-footer"');
        // The only navigation is the footer's legal links.
        expect(count(html, /<nav\b/g), context).toBe(1);
        // the page itself holds no v1 card or control
        const main = /<main\b[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
        expect(main, context).toContain('data-k2-part="Workspace"');
        expect(main, context).not.toMatch(/standalone-card|k2b-button|k2b-notice/);
      }
    }
  });

  test("the device confirmation shows the code, the client, every scope and the own-sign-in warning in English", async () => {
    const html = await renderAuthorizationState("confirm", "en");
    const body = text(html);
    expect(html).toContain("<title>Connect a device");
    expect(body).toContain("Allow Cloud CLI to access your account?");
    // the code stands large in a block of its own, where it is compared with the terminal
    expect(html).toMatch(new RegExp(`data-testid="device-user-code"[^>]*>${sample.code}<`));
    expect(body).toContain("Check that this code matches the one on your device");
    expect(body).toContain(`Client ID ${sample.cli.clientId}`);
    for (const scope of [
      "Identify your Cloud account",
      "Read data and Help available to your account",
      "Perform changes available to your account",
      "Stay connected until you revoke access",
    ])
      expect(body).toContain(scope);
    expect(body).toContain("Only continue if you started this sign-in yourself.");
    expect(body).toContain("Cloud permissions still limit");
    expect(html).toContain('<form id="oauth-decision" method="post" action="/oauth/device"');
    expect(html).toContain(`<input type="hidden" name="request" value="${sample.request}"`);
    // Deny first, Allow last and primary; both send the decision form.
    const [deny, allow, ...more] = submitButtons(html, "oauth-decision");
    expect(more).toEqual([]);
    expect(deny).toContain('name="decision" value="deny"');
    expect(deny).not.toContain("data-variant");
    expect(allow).toContain('name="decision" value="approve"');
    expect(allow).toContain('data-variant="primary"');
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
    expect(heading(html)).toBe(`${sample.dynamic.name} autorisieren`);
    // the client names itself: its whole name also stands where it wraps
    expect(consent).toContain(`Anwendung ${sample.dynamic.name}`);
    expect(consent).toContain("Rückkehr zu localhost:53682");
    expect(consent).toContain("Ressource https://cloud.example/api/mcp/v1");
    expect(consent).toContain(`Client-ID ${sample.dynamic.clientId}`);
    expect(consent).toContain("Für dein Konto verfügbare Änderungen ausführen");
    expect(consent).toContain("nicht verifiziert");
    expect(html).toContain('<form id="oauth-decision" method="post" action="/oauth/consent"');
    expect(consent).toMatch(/Ablehnen .*Zugriff erlauben/);
  });

  test("a sign-in older than 10 minutes swaps Allow for Confirm identity that returns to the same page", async () => {
    for (const [state, returnTo] of [
      ["confirmReauthenticate", `/oauth/device?user_code=${sample.code}&reauthenticate=1`],
      ["consentReauthenticate", `/oauth/consent?request=${sample.request}&reauthenticate=1`],
    ] as const) {
      for (const [locale, hint, button] of [
        ["en", "more than 10 minutes ago", "Confirm identity"],
        ["de", "mehr als 10 Minuten her", "Identität bestätigen"],
      ] as const) {
        const html = await renderAuthorizationState(state, locale);
        const body = text(html);
        const context = `${state} ${locale}`;
        expect(body, context).toContain(hint);
        // No way to allow from here, Deny still works, and the sign-in leads back to this request.
        expect(html, context).not.toContain('value="approve"');
        expect(html, context).toContain('value="deny"');
        const target = new URL(linkTo(html, button)!, "https://cloud.test");
        expect(target.pathname, context).toBe("/auth/login");
        expect(target.searchParams.get("redirectTo"), context).toBe(returnTo);
        expect(body, context).toMatch(new RegExp(`${locale === "en" ? "Deny" : "Ablehnen"} .*${button}`));
      }
    }
    // The device form also sends the code, so a sign-in that aged while the page was open returns here.
    expect(await renderAuthorizationState("confirm", "en")).toContain(`<input type="hidden" name="user_code" value="${sample.code}"`);
  });

  test("cld login gets the consent page without a resource and with the own-sign-in warning", async () => {
    for (const [locale, warning, returns] of [
      ["en", "Only allow this if you just started the sign-in yourself", "Returns to 127.0.0.1:53682"],
      ["de", "Erlaube das nur, wenn du die Anmeldung gerade selbst gestartet hast", "Rückkehr zu 127.0.0.1:53682"],
    ] as const) {
      const html = await renderAuthorizationState("consentCli", locale);
      const body = text(html);
      expect(body, locale).toContain(warning);
      expect(body, locale).toContain(returns);
      expect(body, locale).not.toMatch(/Resource https|Ressource https/);
      expect(body, locale).not.toMatch(/unverified|nicht verifiziert/);
      expect(html, locale).toContain('value="approve"');
    }
  });

  test("code entry is a plain GET form in both languages", async () => {
    for (const [locale, title, button] of [
      ["en", "Connect a device", "Continue"],
      ["de", "Gerät verbinden", "Weiter"],
    ] as const) {
      const html = await renderAuthorizationState("entry", locale);
      expect(text(html)).toContain(title);
      expect(text(html)).toContain(button);
      expect(html).toContain('<form id="oauth-device-code" method="get" action="/oauth/device"');
      // the field and the button send that form without standing in it
      expect(html).toMatch(/<input[^>]*name="user_code"[^>]*form="oauth-device-code"/);
      expect(html).toMatch(/<input[^>]*autocomplete="one-time-code"/);
      // the one field of the page has the focus from the server's markup on
      expect(html).toMatch(/<input[^>]*name="user_code"[^>]*autofocus/);
      expect(submitButtons(html, "oauth-device-code")).toHaveLength(1);
    }
  });

  test("approval ends on a status that says the tab can be closed", async () => {
    for (const [locale, title, body] of [
      ["en", "Device connected", "You can close this tab now."],
      ["de", "Gerät verbunden", "Du kannst diesen Tab jetzt schließen."],
    ] as const) {
      const html = await renderAuthorizationState("approved", locale);
      expect(heading(html)).toBe(title);
      expect(text(html)).toContain(body);
      // the result is read as a status
      expect(html).toMatch(/role="status"[^>]*>[\s\S]*?You can close this tab now|role="status"[^>]*>[\s\S]*?Du kannst diesen Tab/);
      expect(html).not.toContain("<form");
    }
  });

  test("denied, expired and failed requests end calmly with what to do next", async () => {
    const denied = await renderAuthorizationState("denied", "de");
    expect(heading(denied)).toBe("Zugriff abgelehnt");
    expect(text(denied)).toContain("Das Gerät wurde nicht verbunden. Du kannst diesen Tab jetzt schließen.");

    const expired = await renderAuthorizationState("expired", "en");
    expect(heading(expired)).toBe("Request no longer valid");
    expect(linkTo(expired, "Enter another code")).toBe("/oauth/device");

    const failed = await renderAuthorizationState("error", "en");
    expect(failed).toContain("<title>Authorization error");
    expect(heading(failed)).toBe("Authorization failed");
    expect(text(failed)).toContain("Your account is not allowed to use this application.");
    expect(text(failed)).toContain("Error code access_denied");
    expect(linkTo(failed, "Back to home")).toBe("/");

    // a German page says it in German, from the error code; the description its sender wrote stays a detail
    const german = await renderAuthorizationState("error", "de");
    expect(heading(german)).toBe("Autorisierung fehlgeschlagen");
    expect(text(german)).toContain("Der Zugriff wurde nicht erlaubt.");
    expect(text(german)).toContain("Details Dein Konto darf diese Anwendung nicht verwenden.");
    expect(text(failed)).toMatch(/^.*Access was not allowed\..*Details Your account is not allowed/);

    // a code that is no OAuth code is an unknown error; the page never repeats what the address made up
    const forged = text(await renderErrorPage({ error: "<b>Bitte hier klicken</b>", client_name: "x".repeat(300) }, "de"));
    expect(forged).toContain("Ein unbekannter Fehler ist aufgetreten.");
    expect(forged).toContain("Fehlercode unknown_error");
    expect(forged).not.toContain("Bitte hier klicken");
    expect(forged).toContain(`Anwendung ${"x".repeat(200)} `);
    expect(forged).not.toContain("x".repeat(201));
    // a refusal that is no denial says what to do, not that access was not allowed
    for (const [error, sentence] of [
      ["sign_in_again", "Melde dich erneut im Browser an und gib den Code noch einmal ein."],
      ["web_session_required", "Zugriff freigeben geht nur im Web."],
    ] as const) {
      const page = text(await renderErrorPage({ error }, "de"));
      expect(page).toContain(sentence);
      expect(page).not.toContain("Der Zugriff wurde nicht erlaubt.");
    }

    const blocked = await renderAuthorizationState("blocked", "en");
    expect(heading(blocked)).toBe("Authorization failed");
    expect(text(blocked)).toContain("The Cloud app cannot grant access to other applications.");
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
