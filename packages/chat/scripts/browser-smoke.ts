#!/usr/bin/env bun
/**
 * Chat browser regression smoke against a loopback Cloud stack.
 *
 * Two people sign in through Core and exchange messages through the composer.
 * Accounts creates and deletes the disposable person. Only chat cleanup uses
 * SQL, because Chat has no public delete API; its access grants go with it.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { sql } from "bun";
import { type BrowserContext, chromium, type Page, webkit } from "playwright";
import { z } from "zod";
import { SEND_CONVERSATION_WINDOW_SECONDS } from "../src/service/contracts";

const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "base-url": { type: "string", default: "http://localhost:3000" },
    "app-url": { type: "string" },
    "admin-token-file": { type: "string" },
    "webkit-endpoint": { type: "string" },
    headed: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "20000" },
    help: { type: "boolean", default: false },
  },
});
if (options.help) {
  console.log(`Usage: bun packages/chat/scripts/browser-smoke.ts [options]

Options:
  --base-url <url>             Running Cloud server (default http://localhost:3000)
  --app-url <url>              Public Cloud origin for legal consent (default base URL)
  --admin-token-file <path>    File containing the admin token (default token "dev-admin")
  --webkit-endpoint <ws-url>   Connect to a \`playwright run-server\` for WebKit instead of launching it
  --headed                     Show the browser windows
  --keep                       Keep the person and chat after the run
  --timeout-ms <n>             Per-step timeout in milliseconds (default 20000)
  --help                       Show this help without contacting the stack
`);
  process.exit(0);
}

const BASE_URL = options["base-url"];
const APP_ORIGIN = new URL(options["app-url"] ?? BASE_URL).origin;
const TIMEOUT = Number(options["timeout-ms"]);
/**
 * Session sockets must come from the public origin. Nightly reaches its stack on another address, and Chromium sends
 * no Origin header that a test sets on a socket, so there the smoke relays the live socket itself with the public
 * origin. Everything the page sends and receives still passes unchanged.
 */
const relayLiveSocket = async (context: BrowserContext, sessionToken: string) => {
  if (APP_ORIGIN === new URL(BASE_URL).origin) return;
  await context.routeWebSocket(/\/api\/chat\/live$/, (route) => {
    const upstream = new WebSocket(route.url(), { headers: { Origin: APP_ORIGIN, Cookie: `session_token=${sessionToken}` } });
    const waiting: string[] = [];
    upstream.onopen = () => {
      for (const message of waiting.splice(0)) upstream.send(message);
    };
    upstream.onmessage = (event) => route.send(String(event.data));
    upstream.onclose = (event) => route.close({ code: event.code, reason: event.reason });
    route.onMessage((message) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(String(message));
      else waiting.push(String(message));
    });
    route.onClose((code, reason) => upstream.close(code, reason));
  });
};
const ok = (message: string) => console.log(`✓ ${message}`);
function fail(message: string): never {
  throw new Error(message);
}

const assertLocalTarget = () => {
  const url = new URL(BASE_URL);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    fail(`browser smoke only runs against a local loopback URL, received ${url.origin}`);
  if (!Number.isSafeInteger(TIMEOUT) || TIMEOUT <= 0) fail("--timeout-ms must be a positive integer");
};

const api = async (method: string, path: string, body?: unknown, sessionToken?: string, expected = 200): Promise<unknown> => {
  const response = await fetch(new URL(path, BASE_URL), {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      Origin: APP_ORIGIN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  // Authentication responses contain credentials, so failures never print their bodies.
  if (response.status !== expected) fail(`${method} ${path} expected ${expected}, got ${response.status}`);
  return expected === 204 ? undefined : response.json();
};

/** Mirror nightly's consent flow, without following a redirect to the public origin. */
const acceptLegal = async (sessionToken: string) => {
  const response = await fetch(new URL("/auth/continue", BASE_URL), {
    headers: { Cookie: `session_token=${sessionToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (response.status === 302 && response.headers.get("location") === "/") return;
  if (response.status !== 200) fail(`GET /auth/continue expected consent, got ${response.status}`);
  const version = /version:&quot;([a-f0-9]{64})/.exec(await response.text())?.[1];
  if (!version) fail("legal consent page returned no document version");
  await api("POST", "/api/auth/legal-consent", { accepted: true, version }, sessionToken, 204);
};

const SessionSchema = z.object({ session_token: z.string().min(1) });
let adminToken: string | null = null;
let personId: string | null = null;
let chatId: string | null = null;

const createFixture = async () => {
  const tokenFile = options["admin-token-file"];
  const token = tokenFile ? (await readFile(tokenFile, "utf8")).trim() : "dev-admin";
  adminToken = SessionSchema.parse(await api("POST", "/api/auth/admin-login", { token })).session_token;
  await acceptLegal(adminToken);
  ok("admin session ready");

  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  personId = z.object({ id: z.uuid() }).parse(
    await api(
      "POST",
      "/api/accounts/users",
      {
        provider: "local",
        profile: "user",
        givenname: "Chat smoke",
        sn: suffix,
        displayName: `Chat smoke ${suffix}`,
        email: `chat-smoke-${suffix}@example.test`,
        autoSendNotification: false,
      },
      adminToken,
      201,
    ),
  ).id;
  const loginToken = z
    .object({ token: z.string().min(1) })
    .parse(await api("POST", `/api/accounts/users/${personId}/login-token`, undefined, adminToken)).token;
  const personToken = SessionSchema.parse(await api("POST", "/api/auth/verify-token", { token: loginToken })).session_token;
  await acceptLegal(personToken);
  ok("disposable person signed in and accepted the legal documents");

  chatId = z
    .object({ outcome: z.literal("created"), conversation: z.object({ id: z.string().regex(/^[0-9A-Za-z]{6}$/) }) })
    .parse(await api("POST", "/api/chat/conversations", { members: [{ type: "user", userId: personId }] }, adminToken, 201))
    .conversation.id;
  ok(`chat ${chatId} created`);
  return { adminToken, personToken, chatId };
};

const addCookies = async (context: BrowserContext, sessionToken: string, theme: string) => {
  await context.addCookies([
    { name: "session_token", value: sessionToken, url: BASE_URL, httpOnly: true, sameSite: "Lax" },
    { name: "theme", value: theme, url: BASE_URL, sameSite: "Lax" },
    // Prevent Cloud's one-time timezone reload from interrupting the smoke.
    { name: "cloud.timezone", value: "UTC", url: BASE_URL, sameSite: "Lax" },
  ]);
};

declare global {
  interface Window {
    chatSmokeShifts: { sum: number; observer: PerformanceObserver; supported: boolean };
  }
}
const settle = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
const observeShifts = (page: Page) =>
  page.evaluate(() => {
    const supported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if ("hadRecentInput" in entry && !entry.hadRecentInput && "value" in entry && typeof entry.value === "number")
          window.chatSmokeShifts.sum += entry.value;
      }
    });
    window.chatSmokeShifts = { sum: 0, observer, supported };
    if (supported) observer.observe({ type: "layout-shift" });
  });

const composer = (page: Page) => page.locator('.chat-conversation__composer textarea:not([aria-hidden="true"])');
// A line break renders as <br>, which text matching reads as any whitespace.
const textPattern = (text: string) =>
  new RegExp(
    `^${text
      .split("\n")
      .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s*")}$`,
  );
const seeMessage = (page: Page, text: string) => page.locator(".chat-conversation__feed").getByText(textPattern(text)).waitFor();
const sendMessage = async (page: Page, text: string, touch = false) => {
  const field = composer(page);
  if (touch) await field.tap();
  else await field.click();
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) await field.press(touch ? "Enter" : "Shift+Enter");
    await field.pressSequentially(line);
  }
  if ((await field.inputValue()) !== text) fail("composer did not preserve the typed message and line breaks");
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/chat/conversations/${chatId}/messages`,
  );
  if (touch) await page.getByRole("button", { name: "Send message", exact: true }).tap();
  else await field.press("Enter");
  if ((await sent).status() !== 201) fail("composer send did not return 201");
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>('.chat-conversation__composer textarea:not([aria-hidden="true"])')?.value === "",
  );
  await seeMessage(page, text);
};

const assertComposerInViewport = async (page: Page) => {
  const bounds = await page.locator(".chat-conversation__composer").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("visual viewport unavailable");
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      viewportTop: viewport.offsetTop,
      viewportBottom: viewport.offsetTop + viewport.height,
      viewportLeft: viewport.offsetLeft,
      viewportRight: viewport.offsetLeft + viewport.width,
    };
  });
  if (
    bounds.top < bounds.viewportTop ||
    bounds.bottom > bounds.viewportBottom ||
    bounds.left < bounds.viewportLeft ||
    bounds.right > bounds.viewportRight
  )
    fail(`phone composer escaped the visual viewport: ${JSON.stringify(bounds)}`);
};

/** Header and composer edges of the open chat; on WebKit, which has no Layout Instability API, these must not move. */
const frameGeometry = (page: Page) =>
  page.evaluate(() =>
    [".chat-conversation__header", ".chat-conversation__composer"].map((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      if (!box) throw new Error(`${selector} is missing`);
      return { selector, top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    }),
  );
const assertGeometryKept = async (page: Page, before: Awaited<ReturnType<typeof frameGeometry>>) => {
  const after = await frameGeometry(page);
  for (const [index, box] of after.entries()) {
    const start = before[index]!;
    if ((["top", "bottom", "left", "right"] as const).some((edge) => Math.abs(box[edge] - start[edge]) > 0.5))
      fail(`phone ${box.selector} moved while messages arrived: ${JSON.stringify({ before: start, after: box })}`);
  }
};

const runSmoke = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
  const desktop = await chromium.launch({ headless: !options.headed, timeout: TIMEOUT });
  try {
    // Hosts without WebKit's system libraries run it in the Playwright image, as CI does.
    const endpoint = options["webkit-endpoint"];
    const phone = endpoint
      ? await webkit.connect(endpoint, { timeout: TIMEOUT })
      : await webkit.launch({ headless: !options.headed, timeout: TIMEOUT });
    try {
      for (const theme of ["light", "dark"]) {
        // Each round sends eight messages into the same chat; the next one waits out the chat's send window.
        if (theme !== "light") await Bun.sleep(SEND_CONVERSATION_WINDOW_SECONDS * 1000);
        const admin = await desktop.newContext({
          baseURL: BASE_URL,
          viewport: { width: 1440, height: 900 },
          locale: "en",
          timezoneId: "UTC",
        });
        try {
          const person = await phone.newContext({
            baseURL: BASE_URL,
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            locale: "en",
            timezoneId: "UTC",
          });
          try {
            await addCookies(admin, fixture.adminToken, theme);
            await addCookies(person, fixture.personToken, theme);
            await relayLiveSocket(admin, fixture.adminToken);
            await relayLiveSocket(person, fixture.personToken);
            const adminPage = await admin.newPage();
            const personPage = await person.newPage();
            const errors: string[] = [];
            for (const { name, page } of [
              { name: "admin", page: adminPage },
              { name: "person", page: personPage },
            ]) {
              page.setDefaultTimeout(TIMEOUT);
              page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
              await page.goto(`/app/chat/c/${fixture.chatId}`, { waitUntil: "load" });
              await composer(page).waitFor();
              // followVisualViewport installs this style on mount, after SSR was replaced with the interactive view.
              await page.waitForFunction(() =>
                document.querySelector<HTMLElement>(".chat-conversation")?.style.getPropertyValue("--chat-viewport-height"),
              );
              await settle(page);
              if (!(await page.locator("html").evaluate((element, theme) => element.classList.contains(theme), theme)))
                fail(`theme cookie did not apply ${theme}`);
              await observeShifts(page);
            }
            const hello = `${theme} desktop hello`;
            const reply = `${theme} phone reply\non two lines`;
            const messages = [hello, reply];
            await sendMessage(adminPage, hello);
            await seeMessage(personPage, hello);
            await sendMessage(personPage, reply, true);
            await seeMessage(adminPage, reply);
            await assertComposerInViewport(personPage);
            // Layout Instability excludes the 500 ms after input. Let the phone become idle before arrivals.
            await personPage.waitForTimeout(600);
            const phoneFrame = await frameGeometry(personPage);
            for (let index = 1; index <= 5; index += 1) {
              const text = `${theme} idle arrival ${index}`;
              messages.push(text);
              await sendMessage(adminPage, text);
              await seeMessage(personPage, text);
              await settle(personPage);
              await assertComposerInViewport(personPage);
              await assertGeometryKept(personPage, phoneFrame);
            }
            for (const page of [adminPage, personPage]) {
              for (const text of messages) await seeMessage(page, text);
              await settle(page);
              const shifts = await page.evaluate(() => {
                const state = window.chatSmokeShifts;
                for (const entry of state.observer.takeRecords()) {
                  if ("hadRecentInput" in entry && !entry.hadRecentInput && "value" in entry && typeof entry.value === "number")
                    state.sum += entry.value;
                }
                state.observer.disconnect();
                return { sum: state.sum, supported: state.supported };
              });
              if (shifts.sum !== 0) fail(`${theme} layout-shift sum was ${shifts.sum} at ${page.url()}`);
              if (!shifts.supported) console.log("WebKit has no Layout Instability API; header and composer geometry checked instead.");
            }
            // Another context of the first person stays on the list while device 1 reads.
            const secondDevice = await desktop.newContext({
              baseURL: BASE_URL,
              viewport: { width: 1440, height: 900 },
              locale: "en",
              timezoneId: "UTC",
            });
            try {
              await addCookies(secondDevice, fixture.adminToken, theme);
              await relayLiveSocket(secondDevice, fixture.adminToken);
              const listPage = await secondDevice.newPage();
              listPage.setDefaultTimeout(TIMEOUT);
              listPage.on("pageerror", (error) => errors.push(`second device: ${error.message}`));
              await adminPage
                .getByRole("link", { name: /unread/ })
                .and(adminPage.locator(`a[href="/app/chat/c/${fixture.chatId}"]`))
                .waitFor({ state: "hidden" });
              await adminPage.goto("/app/chat", { waitUntil: "load" });
              await listPage.goto("/app/chat", { waitUntil: "load" });
              const chatLink = listPage.getByRole("link").and(listPage.locator(`a[href="/app/chat/c/${fixture.chatId}"]`));
              await chatLink.waitFor();
              await sendMessage(personPage, `${theme} another device unread`, true);
              await listPage
                .getByRole("link", { name: /, 1 unread$/ })
                .and(chatLink)
                .waitFor();
              await adminPage.bringToFront();
              const reading = adminPage.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname === `/api/chat/conversations/${fixture.chatId}/read`,
              );
              await adminPage
                .getByRole("link")
                .and(adminPage.locator(`a[href="/app/chat/c/${fixture.chatId}"]`))
                .click();
              if ((await reading).status() !== 200) fail("opening the chat did not report visible messages read");
              await listPage
                .getByRole("link", { name: /unread/ })
                .and(chatLink)
                .waitFor({ state: "hidden" });
              await chatLink.waitFor();
              ok(`${theme}: device 2's unread count appears and clears after device 1 reads, without reload`);
            } finally {
              await secondDevice.close();
            }
            if (errors.length) fail(`browser errors:\n${errors.join("\n")}`);
            ok(`${theme}: both people see all seven messages; phone header and composer stay in place; observed layout-shift sums are 0`);
          } finally {
            await person.close();
          }
        } finally {
          await admin.close();
        }
      }
    } finally {
      await phone.close();
    }
  } finally {
    await desktop.close();
  }
};

const cleanup = async () => {
  if (options.keep) return;
  try {
    if (personId && adminToken) {
      await api("DELETE", `/api/accounts/users/${personId}`, undefined, adminToken);
      ok("disposable person deleted");
    }
  } finally {
    if (chatId) {
      if (process.env.DATABASE_URL) {
        await sql.begin(async (tx) => {
          // Deleting a conversation cascades to messages, participants and conversation_access, but not auth.access.
          const accessRows = await tx<{ access_id: string }[]>`
            SELECT access_id FROM chat.conversation_access
            WHERE conversation_id = (SELECT id FROM chat.conversations WHERE short_id = ${chatId})
          `;
          await tx`DELETE FROM chat.conversations WHERE short_id = ${chatId}`;
          for (const access of accessRows) await tx`DELETE FROM auth.access WHERE id = ${access.access_id}::uuid`;
        });
        ok("chat and its access grants deleted");
      } else console.log(`DATABASE_URL is unset; chat ${chatId} stays (Chat has no delete API).`);
    }
  }
};

try {
  assertLocalTarget();
  await runSmoke(await createFixture());
  ok("browser smoke complete");
} catch (error) {
  console.error(`\nChat browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    console.error(`fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
