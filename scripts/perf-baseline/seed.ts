import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Cookie } from "playwright";
import { fromJSON } from "seroval";
import { z } from "zod";
import { PwaClaimResultSchema, PwaCompleteResultSchema, PwaPairingStartResultSchema } from "../../packages/cloud/src/contracts/pwa";
import { decodeAttribute, type PageId, type PageResult } from "./model";
import { localTls, type Runtime, waitFor } from "./runtime";

const resourceSchema = z.object({ id: z.string().min(1) });

/** Read only island props; parse props as JSON data, never evaluate them. */
async function consentVersions(html: string) {
  const versions: string[] = [];
  await new HTMLRewriter()
    .on("solid-island, solid-client", {
      element(element) {
        const props: unknown = fromJSON(JSON.parse(decodeAttribute(element.getAttribute("data-props") ?? "")));
        // ConsentForm's version is a string property of its props object.
        if (props && typeof props === "object" && "version" in props) {
          versions.push(
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(props.version),
          );
        }
      },
    })
    .transform(new Response(html))
    .text();
  return versions;
}

export async function extractConsentVersion(html: string): Promise<string> {
  const versions = await consentVersions(html);
  const version = versions[0];
  if (versions.length !== 1 || version === undefined)
    throw new Error(`Consent page must contain exactly one legal version in island props; found ${versions.length}`);
  return version;
}
export const noteContent = `# Performance baseline note

This notebook records the repeatable production rendering baseline. The document has enough structure to exercise the editor, sidebar, and preview without depending on an external service.

## Measurement checklist

- Build minified production bundles.
- Start a fresh isolated installation.
- Use the same content in every run.
- Record both desktop and phone profiles.

## Example

\`\`\`typescript
const measurement = { page: "notebooks-editor", runs: 3 };
console.log(measurement);
\`\`\`

The HTML and import closure describe the initial page weight. Dynamic imports are reported separately because opening a menu or switching an editor view can load more code.

Browser timings depend on the current machine. Compare multiple runs on the same host and inspect the reported range before attributing a small difference to a code change.

### Review notes

The baseline preserves byte counts in JSON. Its Markdown report presents the medians so that a reviewer can compare the changed rendering behavior with the previous build.
`;

export class Api {
  cookie = "";
  constructor(
    readonly origin: string,
    readonly signal: AbortSignal,
  ) {}
  async response(path: string, method = "GET", input?: unknown): Promise<Response> {
    this.signal.throwIfAborted();
    const url = new URL(path, this.origin);
    return fetch(url, {
      ...localTls(url, this.origin),
      method,
      headers: {
        "content-type": "application/json",
        "accept-language": "en",
        Origin: this.origin,
        ...(this.cookie ? { cookie: `session_token=${this.cookie}` } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: "manual",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]),
    });
  }
  async request(path: string, method = "GET", input?: unknown): Promise<unknown> {
    const response = await this.response(path, method, input);
    // Do not print provider input, session tokens, or a reflected response body on failure.
    if (!response.ok) throw new Error(`Public API ${method} ${path} returned HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  async login(token: string, acceptConsent = true) {
    const result = z
      .object({ session_token: z.string().min(1), user: resourceSchema })
      .parse(await this.request("/api/auth/admin-login", "POST", { token }));
    this.cookie = result.session_token;
    const consent = await this.response("/auth/continue");
    if (consent.status === 200) {
      const versions = await consentVersions(await consent.text());
      if (versions.length > 1) throw new Error("Admin consent page contains multiple legal versions");
      const version = versions[0];
      if (version) {
        if (!acceptConsent) throw new Error("Existing installation requires legal consent; accept the terms before using --origin");
        const accepted = await this.response("/api/auth/legal-consent", "POST", { accepted: true, version });
        if (accepted.status !== 204) throw new Error(`Admin legal consent returned HTTP ${accepted.status}; expected 204`);
      }
    } else if (consent.status !== 302)
      throw new Error(`Admin consent page /auth/continue returned HTTP ${consent.status}; expected 200 or 302`);
    const session = await this.response("/api/me");
    if (session.status !== 200)
      throw new Error(
        `Admin session verification GET /api/me after legal consent returned HTTP ${session.status}; expected 200 before seeding`,
      );
    return result.user.id;
  }
  async logout() {
    const response = await this.response("/api/auth/logout", "POST");
    if (response.status !== 200) throw new Error(`Admin sign-out returned HTTP ${response.status}; expected 200`);
    z.object({ message: z.string() }).parse(await response.json());
    this.cookie = "";
  }
}

export const iphoneUserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const phoneCookieNames = ["pwa_session", "pwa_device", "pwa_pairing"];
type PhoneCookie = { name: string; value: string; path: string; expires: number | null };

/** A phone's separate jar. Never accepts or sends the administrator's web cookie. */
export class PhoneSession {
  private readonly cookies = new Map<string, PhoneCookie>();
  constructor(
    readonly origin: string,
    readonly signal: AbortSignal,
  ) {}

  get deviceId() {
    const id = [...this.cookies.values()].find((cookie) => cookie.name === "pwa_device")?.value.split(".")[0];
    if (!id) throw new Error("Mobile app pairing: device cookie missing");
    return id;
  }

  private store(cookie: PhoneCookie) {
    if (!phoneCookieNames.includes(cookie.name)) return;
    const key = `${cookie.name}:${cookie.path}`;
    if (!cookie.value || (cookie.expires !== null && cookie.expires <= Date.now())) this.cookies.delete(key);
    else this.cookies.set(key, cookie);
  }

  private receive(response: Response, requestPath: string) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator < 1) continue;
      const attribute = (name: string) => attributes.find((part) => part.toLowerCase().startsWith(`${name}=`))?.slice(name.length + 1);
      const maxAge = attribute("max-age");
      const expires = attribute("expires");
      const path = attribute("path");
      this.store({
        name: pair.slice(0, separator),
        value: pair.slice(separator + 1),
        path: path?.startsWith("/") ? path : requestPath.slice(0, requestPath.lastIndexOf("/")) || "/",
        expires: maxAge !== undefined && /^-?\d+$/.test(maxAge) ? Date.now() + Number(maxAge) * 1000 : expires ? Date.parse(expires) : null,
      });
    }
  }

  async response(path: string, method = "POST", input?: unknown, signal = this.signal) {
    this.signal.throwIfAborted();
    const url = new URL(path, this.origin);
    const cookie = [...this.cookies.values()]
      .filter(
        (cookie) =>
          (cookie.expires === null || cookie.expires > Date.now()) &&
          (cookie.path === "/" ||
            url.pathname === cookie.path ||
            url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`)),
      )
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const response = await fetch(url, {
      ...localTls(url, this.origin),
      method,
      headers: {
        Origin: this.origin,
        "content-type": "application/json",
        "accept-language": "en",
        "user-agent": iphoneUserAgent,
        ...(cookie ? { cookie } : {}),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
      redirect: "manual",
      signal: AbortSignal.any([this.signal, signal, AbortSignal.timeout(30_000)]),
    });
    this.receive(response, url.pathname);
    return response;
  }

  browserCookies(origin: string): Parameters<BrowserContext["addCookies"]>[0] {
    return [...this.cookies.values()]
      .filter((cookie) => cookie.name !== "pwa_pairing" && (cookie.expires === null || cookie.expires > Date.now()))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        domain: new URL(origin).hostname,
        httpOnly: true,
        secure: new URL(origin).protocol === "https:",
        sameSite: "Lax",
        ...(cookie.expires === null ? {} : { expires: cookie.expires / 1000 }),
      }));
  }

  takeBrowserCookies(cookies: Cookie[]) {
    for (const [key, cookie] of this.cookies) if (cookie.name !== "pwa_pairing") this.cookies.delete(key);
    for (const cookie of cookies) {
      if (cookie.name === "pwa_session" || cookie.name === "pwa_device")
        this.store({
          name: cookie.name,
          value: cookie.value,
          path: cookie.path,
          expires: cookie.expires === -1 ? null : cookie.expires * 1000,
        });
    }
  }
}

async function pairingResponse<T>(step: string, response: Response, status: number, schema: z.ZodType<T>): Promise<T> {
  const failure = () => new Error(`Mobile app pairing: ${step} returned HTTP ${response.status}`);
  if (response.status !== status) throw failure();
  try {
    return schema.parse(response.status === 204 ? undefined : await response.json());
  } catch {
    throw failure();
  }
}

export async function pairPhone(api: Api, origin: string, signal: AbortSignal, name: string) {
  const phone = new PhoneSession(origin, signal);
  try {
    const started = await pairingResponse(
      "start",
      await api.response("/api/auth/pwa/v1/pairings", "POST"),
      201,
      PwaPairingStartResultSchema,
    );
    const claimed = await pairingResponse(
      "claim",
      await phone.response("/pwa/_auth/pairings/claim", "POST", { secret: started.secret, platform: "ios" }),
      200,
      PwaClaimResultSchema,
    );
    await pairingResponse(
      "confirm",
      await api.response(`/api/auth/pwa/v1/pairings/${started.id}/confirm`, "POST", { code: claimed.code }),
      204,
      z.undefined(),
    );
    const polling = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    for (;;) {
      polling.throwIfAborted();
      const response = await phone.response("/pwa/_auth/pairings/complete", "POST", undefined, polling);
      const completed = await pairingResponse("complete", response, response.status === 202 ? 202 : 200, PwaCompleteResultSchema);
      if ((completed.state === "paired") !== (response.status === 200))
        throw new Error(`Mobile app pairing: complete returned HTTP ${response.status}`);
      if (completed.state === "paired") break;
      await sleep(1000, undefined, { signal: polling });
    }
    if (!["pwa_session", "pwa_device"].every((name) => phone.browserCookies(origin).some((cookie) => cookie.name === name)))
      throw new Error("Mobile app pairing: complete returned HTTP 200");
    await pairingResponse("rename", await phone.response("/pwa/_auth/session", "PATCH", { name }), 204, z.undefined());
    return phone;
  } catch (error) {
    if (phone.browserCookies(origin).some((cookie) => cookie.name === "pwa_device")) {
      const cleanupApi = new Api(origin, AbortSignal.timeout(30_000));
      cleanupApi.cookie = api.cookie;
      try {
        await removePhone(cleanupApi, phone.deviceId);
      } catch (cleanup) {
        throw new Error(`${error instanceof Error ? error.message : "Mobile app pairing failed"}; phone cleanup: ${String(cleanup)}`);
      }
    }
    throw error;
  }
}

export async function removePhone(api: Api, deviceId: string) {
  const response = await api.response(`/api/auth/pwa/v1/devices/${encodeURIComponent(deviceId)}`, "DELETE");
  if (response.status !== 204) throw new Error(`Mobile app removal returned HTTP ${response.status}; expected 204`);
}

export const defaultPaths: Record<PageId, string> = {
  document: "/legal/privacy",
  faq: "/faq",
  "mail-mailbox": "/app/mail",
  "assistant-chat": "/app/assistant",
  "notebooks-editor": "/app/notebooks",
  files: "/app/filesv2",
  accounts: "/app/accounts/users",
  spaces: "/app/spaces",
  pwa: "/pwa/",
};

/** Only public application APIs create domain state. Every run has a fresh database. */
export async function seed(api: Api, runtime: Runtime, selected: PageId[], userId: string): Promise<PageResult[]> {
  const pages: PageResult[] = selected.map((id) => ({
    id,
    path: defaultPaths[id],
    status: "ok",
    errors: [],
    notes: [],
    static: null,
    browsers: [],
  }));
  for (const page of pages) {
    runtime.signal.throwIfAborted();
    console.log(`Seeding ${page.id}…`);
    try {
      if (page.id === "spaces") {
        const space = resourceSchema.parse(
          await api.request("/api/spaces", "POST", {
            name: "Performance baseline space",
            description: "Deterministic production measurement fixture",
            starter: "tasks",
          }),
        );
        page.path = `/app/spaces/${space.id}`;
      } else if (page.id === "pwa") {
        const space = resourceSchema.parse(await api.request("/api/spaces", "POST", { name: "Performance baseline", starter: "blank" }));
        const column = resourceSchema.parse(await api.request(`/api/spaces/${space.id}/columns`, "POST", { name: "Open" }));
        const ids = new Set<string>();
        for (let index = 1; index <= 12; index++) {
          const task = resourceSchema.parse(
            await api.request(`/api/spaces/${space.id}/items`, "POST", {
              columnId: column.id,
              title: `Perf task ${String(index).padStart(2, "0")}`,
              assigneeIds: [userId],
            }),
          );
          ids.add(task.id);
        }
        const work = z
          .object({ view: z.literal("mine"), items: z.array(z.object({ shortId: z.string() })) })
          .parse(await api.request("/api/spaces/overview/work?view=mine"));
        if (work.items.filter((item) => ids.has(item.shortId)).length < 12)
          throw new Error("Spaces fixture: mine overview must list all 12 open tasks assigned to the administrator");
        page.notes.push(
          "Spaces fixture: one Space with 12 open tasks assigned to the administrator (Perf task 01–12), verified in the mine overview; check-off is undone after each sample.",
        );
      } else if (page.id === "faq") {
        for (const [question, answer] of [
          [
            "How is the performance baseline measured?",
            "Production bundles are served through a fresh gateway. Three cold browser loads are measured per profile.",
          ],
          [
            "What does time to interactive mean?",
            "The latest of first contentful paint, the end of each initial island mount, the last script response and, in Chromium, the last long task.",
          ],
          [
            "Can these numbers predict a real phone?",
            "The phone profile emulates network and CPU limits on the local machine. Compare runs on the same host.",
          ],
        ])
          await api.request("/api/faq", "POST", { translations: { en: { question, answer } }, audience: ["user", "guest", "anonymous"] });
      } else if (page.id === "notebooks-editor") {
        const book = resourceSchema.parse(
          await api.request("/api/notebooks", "POST", {
            name: "Performance baseline notebook",
            description: "Deterministic production measurement fixture",
            welcomeNote: false,
          }),
        );
        const note = resourceSchema.parse(await api.request(`/api/notebooks/${book.id}/notes`, "POST", { contentMd: noteContent }));
        page.path = `/app/notebooks/${book.id}/notes/${note.id}?mode=write`;
      } else if (page.id === "files") {
        // The fresh installation has no POSIX identities. Reserve a fixture-only
        // range in its own database and backfill the admin through Core's API.
        await api.request("/api/admin/core/linux-identities/configuration", "PUT", {
          config: { enabled: true, rangeStart: 20_000, rangeEnd: 20_099, homeTemplate: "/home/{username}", loginShell: "/bin/bash" },
          rangeReserved: true,
        });
        await api.request(`/api/admin/core/linux-identities/users/${userId}`, "POST");
        await runtime.startFilegate();
        const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
        await api.request("/api/filesv2/admin/configuration", "PUT", {
          url: "http://filegate:4000",
          token: runtime.filegateToken,
          cloud: { ...area, autoCreate: true, autoArchive: true },
          freeipa: { ...area, enabled: false, root: "freeipa" },
        });
        await api.request("/api/filesv2/admin/directories/create", "POST", { area: "cloud", kind: "users", identityId: userId });
        const bases = z
          .object({ items: z.array(resourceSchema.extend({ status: z.string() })) })
          .parse(await api.request("/api/filesv2/bases"));
        const base = bases.items.find((item) => item.status === "existing");
        if (!base) throw new Error("Seeded user file base was not provisioned");
        for (const path of ["Documents", "Research"])
          await api.request(`/api/filesv2/bases/${encodeURIComponent(base.id)}/directories`, "POST", { path });
        for (const path of ["baseline.md", "Documents/review.md", "Research/results.md"])
          await api.request(`/api/filesv2/bases/${encodeURIComponent(base.id)}/markdown`, "POST", { path });
        page.path = `/app/filesv2?base=${encodeURIComponent(base.id)}`;
        page.notes.push("Files fixture: two folders and three empty Markdown files; no upload leases or document converter are used.");
      } else if (page.id === "assistant-chat") {
        const chat = resourceSchema.parse(await api.request("/api/ai/conversations", "POST", { title: "Performance baseline chat" }));
        page.path = `/app/assistant?conversation=${encodeURIComponent(chat.id)}`;
        page.notes.push(
          "Seeded empty Assistant conversation through the public API; no AI provider, model requests, or generated messages.",
        );
      } else if (page.id === "mail-mailbox") {
        const mailbox = resourceSchema.parse(
          await api.request("/api/mail/mailboxes", "POST", {
            name: "Performance baseline mailbox",
            description: "Throwaway mailbox; never uses real credentials",
          }),
        );
        page.path = `/app/mail/${mailbox.id}`;
        // The connector only accepts public hosts with verified TLS, so a throwaway local
        // IMAP server cannot be connected without weakening that policy. The mailbox view
        // and its eager JS are the same; the message list is empty and the props are smaller.
        page.notes.push(
          "Mailbox view without a provider connection: empty message list, smaller props, same eager JS. The Mail connector accepts only public hosts with verified TLS.",
        );
      }
    } catch (error) {
      page.status = "failed";
      page.errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return pages;
}

export async function waitForRoutes(api: Api, apps: string[], runtime: Runtime) {
  // Gateway health exposes a count, not app names. Confirm each app's public route
  // separately with the session. Core must prove authentication even when only
  // public pages (FAQ or legal documents) are selected. Never follow auth redirects.
  const routes: Record<string, string> = {
    core: "/api/me",
    faq: "/faq",
    mail: "/app/mail",
    assistant: "/app/assistant",
    notebooks: "/app/notebooks",
    spaces: "/app/spaces",
    filesv2: "/app/filesv2",
    accounts: "/app/accounts/users",
    pwa: "/pwa/manifest.webmanifest",
  };
  for (const app of apps) {
    const path = routes[app];
    if (!path) continue;
    await waitFor(
      `gateway route for ${app}`,
      async () => {
        const url = `${api.origin}${path}`;
        const response = await fetch(url, {
          ...localTls(url, api.origin),
          headers: app === "pwa" ? {} : { cookie: `session_token=${api.cookie}` },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        return response.status === 200;
      },
      runtime.signal,
    );
  }
}
