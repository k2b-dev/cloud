import { LocaleProvider, SettingsModal } from "@k2b/ui";
import { render } from "solid-js/web";
import type { ComposeTemplate, MailboxComposeLogo } from "../../contracts";
import MailComposeSettings from "./MailComposeSettings";
import { mailSettingsMessages } from "./mail-settings-messages";

type Logo = NonNullable<MailboxComposeLogo["logo"]>;

export type ComposeSettingsHarnessOptions = {
  locale: "en" | "de";
  permission: "write" | "admin";
  /** The stored logo the first load answers with; `"fail"` answers with a server error. */
  logo: Logo | null | "fail";
  /** A 400 message the next upload answers with, as the server's localized validation error. */
  uploadError?: string;
  conflict?: boolean;
};

declare global {
  interface Window {
    mountComposeSettings: (options: ComposeSettingsHarnessOptions) => void;
    /** Answers the pending logo load, so a test can measure the loading state first. */
    answerLogoLoad: () => void;
    /** A demo logo drawn in the page: an app-colored mark and a team name, `width`×`height` pixels. */
    demoLogo: (width: number, height: number, displayWidth: number) => Promise<Logo>;
    logoRequests: { method: string; body: unknown }[];
  }
}

const now = "2026-10-11T10:00:00.000Z";
const template = (id: string, kind: ComposeTemplate["kind"], name: string, shortcut: string): ComposeTemplate => ({
  id,
  mailboxId: "Box001",
  kind,
  scope: "mailbox",
  ownerUserId: null,
  name,
  shortcut,
  body: kind === "signature" ? "Kind regards\n\n{{ mailbox.logo }}" : "Thanks for your message.",
  revision: 1,
  archivedAt: null,
  createdAt: now,
  updatedAt: now,
});

window.demoLogo = async (width, height, displayWidth) => {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  const unit = height / 10;
  context.fillStyle = "#0f766e";
  context.beginPath();
  context.arc(unit * 5, unit * 5, unit * 3.6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#ffffff";
  context.fillRect(unit * 3.4, unit * 4.3, unit * 3.2, unit * 1.4);
  context.fillStyle = "#18181b";
  context.font = `600 ${unit * 2.2}px system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.fillText("Example Team", unit * 10, unit * 5.2);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await new Promise<string>((done) => {
    const reader = new FileReader();
    reader.onload = () => done(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return {
    versionId: "10000000-0000-4000-8000-000000000001",
    contentType: "image/png",
    pixelWidth: width,
    pixelHeight: height,
    displayWidth,
    altText: "Example Team",
    byteLength: blob.size,
    sha256: "a".repeat(64),
    dataUrl,
    createdAt: now,
  };
};

window.mountComposeSettings = (options) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  document.documentElement.lang = options.locale;
  const messages = mailSettingsMessages.resolve([options.locale]).t;
  let stored = options.logo === "fail" ? null : options.logo;
  let failLoad = options.logo === "fail";
  let conflict = options.conflict;
  let answer: () => void = () => undefined;
  const loaded = new Promise<void>((done) => {
    answer = done;
  });
  window.answerLogoLoad = () => answer();
  window.logoRequests = [];
  const originalFetch = window.fetch;
  window.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), location.href), init);
      const path = new URL(request.url).pathname;
      if (!path.endsWith("/compose-logo")) throw new Error(`Unexpected request: ${request.method} ${path}`);
      const body = request.method === "PUT" ? await request.json() : null;
      window.logoRequests.push({ method: request.method, body });
      if (request.method === "GET") {
        await loaded;
        if (failLoad) {
          failLoad = false;
          return Response.json({ message: "Mail could not process the request" }, { status: 500 });
        }
        return Response.json({ logo: stored });
      }
      if (request.method === "DELETE") {
        stored = null;
        return Response.json({ logo: null });
      }
      if (conflict && stored) {
        conflict = false;
        stored = { ...(await window.demoLogo(600, 160, 240)), versionId: "20000000-0000-4000-8000-000000000002", altText: "New team logo" };
        return Response.json({ code: "CONFLICT" }, { status: 409 });
      }
      if (options.uploadError) return Response.json({ code: "BAD_INPUT", message: options.uploadError }, { status: 400 });
      const json = body as { content: string; displayWidth?: number; altText?: string };
      const current = stored ?? (await window.demoLogo(600, 200, 200));
      stored = { ...current, displayWidth: json.displayWidth ?? 200, altText: json.altText ?? "Example Team" };
      return Response.json({ logo: stored });
    },
    { preconnect: originalFetch.preconnect },
  );
  render(
    () => (
      <LocaleProvider locale={options.locale}>
        <SettingsModal title={messages.mailboxSettings} defaultTab="writing">
          <SettingsModal.Group title={messages.mailboxSettings}>
            <SettingsModal.Tab id="writing" title={messages.writing} icon="ti ti-pencil">
              <MailComposeSettings
                mailboxId="Box001"
                permission={options.permission}
                initialTemplates={[
                  template("Sign01", "signature", "Team signature", "team"),
                  template("Snip01", "snippet", "Thanks", "thanks"),
                ]}
                initialDefaults={[]}
                initialStyle={{ formattingWarnings: [], mailboxId: "Box001", customCss: "", revision: 1, updatedAt: now }}
                identities={[]}
              />
            </SettingsModal.Tab>
          </SettingsModal.Group>
        </SettingsModal>
      </LocaleProvider>
    ),
    host,
  );
};
