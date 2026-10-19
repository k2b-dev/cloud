import { resolve } from "node:path";
import { solid } from "../scripts/build";
import { iconStyles } from "../scripts/icons";
import type { Login } from "./authenticator";

/** Who asks, for every level and fallback the sign-in sheet knows; `undefined` is a Cloud without login context. */
export const decisionStates = {
  known: {
    level: "info",
    browser: "firefox",
    os: "windows",
    country: "AT",
    city: "Wien",
    network: "Magenta Telekom",
    history: { knownSince: "2026-03-12T08:00:00.000Z", newCountry: false, countriesSince: null },
    sameNetwork: true,
  },
  first: {
    level: "hint",
    browser: "chrome",
    os: "macos",
    country: "AT",
    city: "Wien",
    network: "A1 Telekom Austria",
    history: { knownSince: null, newCountry: false, countriesSince: null },
  },
  country: {
    level: "hint",
    browser: "safari",
    os: "mac-or-ipad",
    country: "IT",
    city: "Rom",
    network: "Telecom Italia",
    history: { knownSince: "2026-05-02T08:00:00.000Z", newCountry: true, countriesSince: null },
  },
  since: {
    level: "hint",
    browser: "safari",
    os: "mac-or-ipad",
    country: "IT",
    city: "Rom",
    network: "Telecom Italia",
    history: { knownSince: "2026-05-02T08:00:00.000Z", newCountry: true, countriesSince: "2026-09-01T08:00:00.000Z" },
  },
  network: {
    level: "hint",
    browser: "chrome",
    os: "windows",
    country: "DE",
    city: "Frankfurt am Main",
    network: "Hetzner Online",
    history: { knownSince: null, newCountry: false, countriesSince: null },
  },
  nogeo: {
    level: "info",
    browser: "firefox",
    os: "windows",
    country: null,
    city: null,
    network: null,
    history: { knownSince: "2026-03-12T08:00:00.000Z", newCountry: false, countriesSince: null },
    sameNetwork: true,
  },
  sparse: {
    level: "info",
    browser: "other",
    os: "other",
    country: "AT",
    city: null,
    network: null,
    history: { knownSince: "2026-03-12T08:00:00.000Z", newCountry: false, countriesSince: null },
  },
  noplace: {
    level: "hint",
    browser: "edge",
    os: "linux",
    country: null,
    city: null,
    network: "Example Networks",
    history: { knownSince: null, newCountry: false, countriesSince: null },
  },
  intro: {
    level: "info",
    browser: "firefox",
    os: "windows",
    country: "AT",
    city: "Wien",
    network: "Magenta Telekom",
    history: null,
    sameNetwork: true,
  },
  warn: {
    level: "warn",
    browser: "edge",
    os: "windows",
    country: "PL",
    city: "Warschau",
    network: "OVH",
    history: { knownSince: null, newCountry: true, countriesSince: null },
  },
  warnSince: {
    level: "warn",
    browser: "edge",
    os: "windows",
    country: "PL",
    city: "Warschau",
    network: "OVH",
    history: { knownSince: null, newCountry: true, countriesSince: "2026-09-01T08:00:00.000Z" },
  },
  legacy: undefined,
} satisfies Record<string, Login["context"]>;
export type DecisionState = keyof typeof decisionStates;
/** How the fake Cloud answers a decision: confirmed, lost (uncertain) or never (still sending). */
export type DecisionAnswer = "ok" | "lost" | "hang";

declare global {
  interface Window {
    openDecision: (options: { locale: "en" | "de"; state: DecisionState; answer: DecisionAnswer }) => void;
    expire: () => void;
    setOnline: (online: boolean) => void;
    /** A later poll: the same request with a different same-network hint. */
    refresh: () => void;
  }
}

const entry = resolve(import.meta.dir, "decision.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { Clouds } from "./Clouds";
const states = ${JSON.stringify(decisionStates)};
const createdAt = "2026-10-24T07:14:00.000Z";
const expiresAt = "2026-10-24T07:19:00.000Z";
window.openDecision = ({ locale, state, answer }) => {
  const [now, setNow] = createSignal(Date.parse("2026-10-24T07:15:00.000Z"));
  const [online, setOnline] = createSignal(true);
  window.expire = () => setNow(Date.parse(expiresAt));
  window.setOnline = setOnline;
  const binding = { id: "fixture", label: "Hoffmann Druck", name: "Hoffmann", issuer: "https://cloud.hoffmann-druck.test", deviceId: "device", key: {} };
  const context = states[state];
  const request = { requestId: "login", comparison: "623775", challenge: "unused", createdAt, expiresAt, ...(context ? { context } : {}) };
  const second = { ...request, requestId: "second", createdAt: "2026-10-24T07:14:30.000Z" };
  const queue = context?.level === "warn" ? [request, second] : [request];
  const [inbox, setInbox] = createSignal({ fixture: { requests: queue, actions: [], moreActions: 0 } });
  window.refresh = () =>
    setInbox({
      fixture: {
        requests: inbox().fixture.requests.map((item) => {
          if (!item.context) return item;
          const { sameNetwork, ...rest } = item.context;
          return { ...item, context: sameNetwork ? rest : { ...rest, sameNetwork: true } };
        }),
        actions: [],
        moreActions: 0,
      },
    });
  const noop = async () => {};
  const auth = {
    bindings: () => [binding],
    states: inbox,
    now,
    online,
    storageError: () => false,
    changed: noop,
    client: noop,
    stored: async () => undefined,
    account: noop,
    action: noop,
    act: noop,
    decide: async (_binding, decided) => {
      if (answer === "lost") throw new Error("The response was lost");
      if (answer === "hang") return new Promise(() => {});
      setInbox({ fixture: { requests: inbox().fixture.requests.filter((item) => item.requestId !== decided.requestId), actions: [], moreActions: 0 } });
    },
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences = { locale: () => locale, language: () => locale, theme: () => "light", setLanguage() {}, setTheme() {} };
  render(() => createComponent(Clouds, { auth, preferences }), document.getElementById("root"));
};
`;

/** The shipped styles and icons with a fixture that opens the sign-in sheet in one state. */
export async function decisionPage() {
  const built = await Bun.build({
    entrypoints: [entry, resolve(import.meta.dir, "styles.css")],
    files: { [entry]: fixture },
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [solid],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!built.success) throw new AggregateError(built.logs, "Could not bundle the decision fixture.");
  const script = await built.outputs.find((output) => output.path.endsWith(".js"))!.text();
  const css = (await built.outputs.find((output) => output.path.endsWith(".css"))!.text()) + (await iconStyles(script));
  return {
    script,
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}</style></head><body class="k2b-ui"><div id="root"></div></body></html>`,
  };
}
