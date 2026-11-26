import { describe, expect, test } from "bun:test";
import {
  type AuthorizationState,
  approvedRequests,
  authorizationStates,
  refusedRequests,
  renderAuthorizationState,
  renderConnected,
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
    // the head names the asking application with its mark, once, before the code
    expect(heading(html)).toBe(sample.cli.name);
    expect(body.split(sample.cli.name)).toHaveLength(2);
    expect(body.indexOf(sample.cli.name)).toBeLessThan(body.indexOf("Check that this code matches"));
    // the code stands large in a block of its own, where it is compared with the terminal
    expect(html).toMatch(new RegExp(`data-testid="device-user-code"[^>]*>${sample.code}<`));
    expect(body).toContain("Check that this code matches the one on your device");
    // the question names the application once; no facts repeat its name or its ID
    expect(body.split("Cloud CLI")).toHaveLength(2);
    expect(body).not.toContain(`Client ID ${sample.cli.clientId}`);
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
    // one rhythm: the application, the code to compare, what it asks for, for which account, the decision
    expect(confirm).toMatch(/^ Cloud CLI Zeigt dein Gerät denselben Code\? Prüfe/);
    expect(confirm.indexOf("Für dein Konto AR Ada Renz")).toBeGreaterThan(confirm.indexOf("Angeforderter Zugriff"));
    expect(confirm.indexOf("Für dein Konto AR Ada Renz")).toBeLessThan(confirm.indexOf("Ablehnen"));
    expect(confirm).toContain("Prüfe, ob dieser Code mit dem auf deinem Gerät übereinstimmt");
    expect(confirm).not.toContain("Client-ID");
    expect(confirm).toContain("Fahre nur fort, wenn du diese Anmeldung selbst gestartet hast.");
    expect(confirm).toMatch(/Ablehnen .*Zugriff erlauben/);

    const html = await renderAuthorizationState("consent", "de");
    const consent = text(html);
    expect(html).toContain("<title>Anwendung autorisieren");
    // the head names the asking application once, with its mark and that nobody checked it
    expect(heading(html)).toBe(sample.dynamic.name);
    expect(consent.split(sample.dynamic.name)).toHaveLength(2);
    expect(consent).toMatch(new RegExp(`^ ${sample.dynamic.name} Nicht geprüft Angeforderter Zugriff`));
    // the technical facts stand quiet after who decides, before the decision
    expect(consent.indexOf("Technische Angaben")).toBeGreaterThan(consent.indexOf("Für dein Konto"));
    expect(consent.indexOf("Technische Angaben")).toBeLessThan(consent.indexOf("Ablehnen"));
    expect(consent).toContain("Rückkehr zu notizen.werkstatt.example");
    expect(consent).toContain("Ressource https://cloud.werkstatt.example/api/mcp/v1");
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
      // it names what was connected; the person stands once, signed in above it
      expect(text(html)).toContain(
        locale === "de" ? "Cloud CLI ist jetzt mit deinem Konto verbunden." : "Cloud CLI is now connected to your account.",
      );
      expect(text(html).split("Ada Renz")).toHaveLength(2);
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
    expect(text(failed)).toContain("Error code account_not_allowed");
    expect(linkTo(failed, "Back to home")).toBe("/");

    // a German page says it in German, from the error code, once
    const german = await renderAuthorizationState("error", "de");
    expect(heading(german)).toBe("Autorisierung fehlgeschlagen");
    expect(text(german)).toContain("Dein Konto darf diese Anwendung nicht verwenden.");

    // the page shows no text from the address: a code it does not send is an unknown error, and a description or a
    // client name in the address appears nowhere
    const forged = text(
      await renderErrorPage({ error: "<b>Bitte hier klicken</b>", error_description: "Ruf 0800 an", client_name: "Bank" }, "de"),
    );
    expect(forged).toContain("Ein unbekannter Fehler ist aufgetreten.");
    expect(forged).toContain("Fehlercode unknown_error");
    for (const made of ["Bitte hier klicken", "Ruf 0800 an", "Bank"]) expect(forged).not.toContain(made);
    const described = text(await renderErrorPage({ error: "consent_expired", error_description: "Ruf 0800 an" }, "de"));
    expect(described).toContain("Die Zustimmungsanfrage ist nicht mehr gültig");
    expect(described).not.toContain("Ruf 0800 an");
    // a refusal that is no denial says what to do, not that access was not allowed
    for (const [error, sentence] of [
      ["sign_in_again", "Melde dich erneut im Browser an und gib den Code noch einmal ein."],
      ["web_session_required", "Zugriff freigeben geht nur im Web."],
    ] as const) {
      const page = text(await renderErrorPage({ error }, "de"));
      expect(page).toContain(sentence);
      expect(page).not.toContain("Der Zugriff wurde nicht erlaubt.");
    }

    // the application is named only for the refused request itself: open, set up by an administrator, and one the
    // signed-in person may indeed not use; a guessed request or client names nothing
    const refused = { error: "account_not_allowed" };
    expect(text(await renderErrorPage({ ...refused, request: refusedRequests.terminal }, "de"))).toContain(
      "Dein Konto darf Drucker-Terminal nicht verwenden.",
    );
    for (const [request, visitor] of [
      [refusedRequests.terminal, "anonymous"],
      [refusedRequests.dynamic, "signed-in"],
      [refusedRequests.kiosk, "signed-in"],
      ["66666666-6666-4666-8666-666666666666", "signed-in"],
      ["drucker-terminal", "signed-in"],
    ] as const) {
      const page = text(await renderErrorPage({ ...refused, request, client: sample.terminal.clientId }, "de", visitor));
      expect(page, `${request} ${visitor}`).toContain("Dein Konto darf diese Anwendung nicht verwenden.");
      for (const name of [sample.terminal.name, sample.dynamic.name, sample.kiosk.name]) expect(page).not.toContain(name);
    }
    // the reason, its code, then the way on
    expect(text(await renderErrorPage(refused, "de"))).toMatch(/nicht verwenden\. Fehlercode account_not_allowed Zur Startseite/);

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

// The connected page names what this person approved, by the decision's request, never by a name in the address: a
// request of someone else, a self-registered application or a made-up request says the generic sentence.
test("the connected page names only an application this person approved and an administrator set up", async () => {
  expect(text(await renderConnected(approvedRequests.terminal, "de"))).toContain(
    "Drucker-Terminal ist jetzt mit deinem Konto verbunden.",
  );
  for (const request of [approvedRequests.dynamic, "44444444-4444-4444-8444-444444444444", "kein-uuid"]) {
    const page = text(await renderConnected(request, "de"));
    expect(page, request).toContain("Du kannst diesen Tab jetzt schließen.");
    expect(page, request).not.toContain(sample.dynamic.name);
    expect(page, request).not.toContain("ist jetzt mit deinem Konto verbunden");
  }
});
