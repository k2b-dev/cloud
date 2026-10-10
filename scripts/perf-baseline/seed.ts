import { z } from "zod";
import { decodeAttribute, type PageId, type PageResult } from "./model";
import { localTls, type Runtime, waitFor } from "./runtime";

const resourceSchema = z.object({ id: z.string().min(1) });

/** Read only island props, as static measurement does; never execute seroval. */
export async function extractConsentVersion(html: string): Promise<string> {
  const versions: string[] = [];
  await new HTMLRewriter()
    .on("solid-island, solid-client", {
      element(element) {
        const props = decodeAttribute(element.getAttribute("data-props") ?? "");
        // ConsentForm's version is a string property in the serialized object.
        for (const match of props.matchAll(/(?:^|[,{])\s*(?:version|"version")\s*:\s*("(?:\\.|[^"\\])*")/g)) {
          const value: unknown = JSON.parse(match[1] ?? "null");
          versions.push(
            z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .parse(value),
          );
        }
      },
    })
    .transform(new Response(html))
    .text();
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
  async login(token: string) {
    const result = z
      .object({ session_token: z.string().min(1), user: resourceSchema })
      .parse(await this.request("/api/auth/admin-login", "POST", { token }));
    this.cookie = result.session_token;
    const consent = await this.response("/auth/continue");
    if (consent.status !== 200) throw new Error(`Admin consent page /auth/continue returned HTTP ${consent.status}; expected 200`);
    const version = await extractConsentVersion(await consent.text());
    const accepted = await this.response("/api/auth/legal-consent", "POST", { accepted: true, version });
    if (accepted.status !== 204) throw new Error(`Admin legal consent returned HTTP ${accepted.status}; expected 204`);
    const session = await this.response("/api/me");
    if (session.status !== 200)
      throw new Error(
        `Admin session verification GET /api/me after legal consent returned HTTP ${session.status}; expected 200 before seeding`,
      );
    return result.user.id;
  }
}

export const defaultPaths: Record<PageId, string> = {
  document: "/legal/privacy",
  faq: "/faq",
  "mail-mailbox": "/app/mail",
  "assistant-chat": "/app/assistant",
  "notebooks-editor": "/app/notebooks",
  files: "/app/filesv2",
  accounts: "/app/accounts/users",
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
      if (page.id === "faq") {
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
    filesv2: "/app/filesv2",
    accounts: "/app/accounts/users",
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
          headers: { cookie: `session_token=${api.cookie}` },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        return response.status === 200;
      },
      runtime.signal,
    );
  }
}
