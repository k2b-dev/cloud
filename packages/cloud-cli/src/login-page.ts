import { type CloudCliText, localizeCloudCliText } from "@k2b/cloud/cli";

/** How one request to the loopback callback of `cld login` ended. */
export type LoginPageOutcome = "success" | "denied" | "mismatch" | "expired" | "failed";

type OutcomeView = {
  status: number;
  /** Tabler outline icon: the strokes inside the shared circle. */
  icon: string;
  title: CloudCliText;
  body: CloudCliText;
};

const OUTCOMES: Record<LoginPageOutcome, OutcomeView> = {
  success: {
    status: 200,
    icon: '<path d="M9 12l2 2l4 -4"/>',
    title: { en: "Cloud CLI connected", de: "Cloud CLI verbunden" },
    body: {
      en: "You can close this tab now and return to your terminal.",
      de: "Du kannst diesen Tab jetzt schließen und zu deinem Terminal zurückkehren.",
    },
  },
  denied: {
    status: 200,
    icon: '<path d="M10 10l4 4m0 -4l-4 4"/>',
    title: { en: "Access denied", de: "Zugriff abgelehnt" },
    body: {
      en: "The Cloud CLI was not connected. You can close this tab now. To sign in after all, run cld login again in your terminal.",
      de: "Die Cloud CLI wurde nicht verbunden. Du kannst diesen Tab jetzt schließen. Um dich doch anzumelden, führe cld login erneut in deinem Terminal aus.",
    },
  },
  mismatch: {
    status: 400,
    icon: '<path d="M12 8v4"/><path d="M12 16h.01"/>',
    title: { en: "This page does not match your sign-in", de: "Diese Seite passt nicht zu deiner Anmeldung" },
    body: {
      en: "It does not belong to the sign-in that is waiting in your terminal. Open the login URL printed there again.",
      de: "Sie gehört nicht zu der Anmeldung, die in deinem Terminal wartet. Öffne die dort ausgegebene Anmelde-URL erneut.",
    },
  },
  expired: {
    status: 410,
    icon: '<path d="M12 7v5l3 3"/>',
    title: { en: "Request no longer valid", de: "Anfrage nicht mehr gültig" },
    body: {
      en: "This sign-in was already answered. Check your terminal, and run cld login again if you are not signed in.",
      de: "Diese Anmeldung wurde bereits beantwortet. Sieh in deinem Terminal nach und führe cld login erneut aus, falls du nicht angemeldet bist.",
    },
  },
  failed: {
    status: 400,
    icon: '<path d="M12 8v4"/><path d="M12 16h.01"/>',
    title: { en: "Sign-in failed", de: "Anmeldung fehlgeschlagen" },
    body: {
      en: "The Cloud CLI was not connected. Run cld login again in your terminal.",
      de: "Die Cloud CLI wurde nicht verbunden. Führe cld login erneut in deinem Terminal aus.",
    },
  },
};

/**
 * The page has no script, image, font, or link, so the policy allows only its
 * own inline style. The callback URL carries the authorization code: nothing
 * on the page may load, submit, or frame anything that could leak it.
 */
export const LOGIN_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/*
 * The look of Cloud's device approval result (`/oauth/device`): one calm,
 * centered card on the page background, flat on phones. The values are the
 * `@k2b/ui` tokens written out, because the compiled binary cannot load a
 * stylesheet and the page must not request one.
 */
const STYLE = `
:root{color-scheme:light dark;--canvas:#fafafa;--surface:#fff;--border:rgb(228 228 231/.72);--text:#09090b;--muted:#52525b;--success:#047857;--shadow:0 -3px 10px -8px rgb(15 23 19/.16),0 0 16px -9px rgb(15 23 19/.16),0 14px 36px -32px rgb(15 23 19/.22),0 1px 5px rgb(15 23 19/.04)}
@media (prefers-color-scheme:dark){:root{--canvas:#090d12;--surface:#11151b;--border:rgb(41 49 58/.72);--text:#fafafa;--muted:#a1a1aa;--success:#6ee7b7;--shadow:0 -3px 10px -8px rgb(0 0 0/.32),0 0 16px -9px rgb(0 0 0/.56),0 16px 40px -30px rgb(0 0 0/.48),0 1px 7px rgb(0 0 0/.14)}}
*{box-sizing:border-box}
html{height:100%;-webkit-text-size-adjust:100%}
body{margin:0;min-height:100%;display:flex;align-items:center;justify-content:center;padding:2rem 1rem;background:var(--canvas);color:var(--text);font:400 1rem/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:28rem;padding:2rem;border:1px solid var(--border);border-radius:.75rem;background:var(--surface);box-shadow:var(--shadow);text-align:center}
svg{display:block;width:2.25rem;height:2.25rem;margin:0 auto;color:var(--muted)}
.success svg{color:var(--success)}
h1,p{text-wrap:balance}
h1{margin:.75rem 0 0;font-size:1.25rem;font-weight:600;line-height:1.375;overflow-wrap:anywhere}
p{margin:.5rem 0 0;font-size:.875rem;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
code{display:block;margin-top:1rem;font:400 .75rem/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}
@media not all and (min-width:48rem){main{padding:0;border:0;border-radius:0;background:none;box-shadow:none}}
`.trim();

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/**
 * The page `cld login` shows in the browser once the loopback callback has an
 * answer. `detail` is text the authorization server sent (an OAuth error); it
 * is the only caller-supplied value on the page and is always escaped.
 */
export const loginPageHtml = (outcome: LoginPageOutcome, options: { locale: string; detail?: string }): string => {
  const view = OUTCOMES[outcome];
  const title = escapeHtml(localizeCloudCliText(options.locale, view.title));
  const body = escapeHtml(localizeCloudCliText(options.locale, view.body));
  const lang = localizeCloudCliText(options.locale, { en: "en", de: "de" });
  const detail = options.detail ? `<code>${escapeHtml(options.detail)}</code>` : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main role="status" class="${outcome}">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>${view.icon}</svg>
<h1>${title}</h1>
<p>${body}</p>${detail}
</main>
</body>
</html>
`;
};

export const loginPageResponse = (outcome: LoginPageOutcome, options: { locale: string; detail?: string }): Response =>
  new Response(loginPageHtml(outcome, options), {
    status: OUTCOMES[outcome].status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": LOGIN_PAGE_CSP,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
