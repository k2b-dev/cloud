import { appApproval } from "@k2b/cloud/browser/app-approval";
import { Button, LocaleProvider, MobileShell, Placeholder } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { ActionView, Authenticator, InboxState, Login } from "./authenticator";
import { Clouds } from "./Clouds";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

// The home screen with fictional Clouds in every state of the card, for browser tests and screenshots.

const now = Date.parse("2026-11-03T13:33:00.000Z");
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const until = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const binding = async (id: string, label: string, issuer: string): Promise<Binding> => ({
  id,
  label,
  name: "Pixel 9",
  issuer,
  deviceId: `${id}-device`,
  key: await appApproval.createKey(),
});

const login = (id: string, minutes: number, context?: Login["context"], terminal?: Login["terminal"]): Login => ({
  requestId: id,
  comparison: "482913",
  challenge: "unused",
  createdAt: at(minutes),
  expiresAt: until(4),
  ...(context ? { context } : {}),
  ...(terminal ? { terminal } : {}),
});
const known: Login["context"] = {
  level: "info",
  browser: "firefox",
  os: "macos",
  country: "DE",
  city: "Berlin",
  network: "Telekom",
  history: { knownSince: "2026-03-12T08:00:00.000Z", newCountry: false, countriesSince: null },
};
const unfamiliar: Login["context"] = {
  level: "hint",
  browser: "safari",
  os: "ios",
  country: "DE",
  city: "Hamburg",
  network: "Vodafone",
  history: { knownSince: null, newCountry: false, countriesSince: null },
  sameNetwork: true,
};
const unusual: Login["context"] = {
  level: "warn",
  browser: "chrome",
  os: "windows",
  country: "PT",
  city: "Lissabon",
  network: null,
  history: { knownSince: null, newCountry: true, countriesSince: null },
};
const action: ActionView = {
  actionId: "action",
  app: { id: "files", name: "Dateien" },
  requester: { app: { id: "assistant", name: "Assistant" }, title: "Aufräumen Projektordner" },
  assurance: "confirm",
  sentence: "Datei „Q3-Bericht.pdf“ löschen",
  message: "Im Ordner soll nur noch die aktuelle Fassung liegen.",
  details: [
    { label: "Ordner", value: "Projekte / 2026" },
    { label: "Geändert", value: "2026-10-28T15:05:00.000Z", format: "date-time" },
  ],
  truncated: false,
  argsDigest: "input",
  digest: "unused",
  createdAt: at(4),
  expiresAt: until(9),
};
const empty = (): InboxState => ({ requests: [], actions: [], changes: [], moreActions: 0, moreChanges: 0 });
const inbox = (change: Partial<InboxState>): InboxState => ({ ...empty(), ...change });

export const cardScenarios = {
  idle: { ex: inbox({}), tp: inbox({}) },
  one: { ex: inbox({ requests: [login("one", 1, known)] }), tp: inbox({}) },
  many: {
    ex: inbox({ requests: [login("first", 1, known), login("second", 0, unfamiliar)] }),
    tp: inbox({ requests: [login("unusual", 2, unusual)] }),
  },
  mixed: {
    ex: inbox({ actions: [action], moreActions: 2 }),
    tp: inbox({
      changes: [
        {
          changeId: "pair",
          kind: "pair",
          device: { id: "ipad", name: "iPad von Alex" },
          endSessions: false,
          createdAt: at(5),
          expiresAt: until(5),
        },
      ],
      requests: [
        login("terminal", 3, undefined, {
          client: { id: "cloud-cli", name: "cld" },
          scopes: ["read", "write"],
          lifetimeSeconds: 30 * 24 * 3600,
        }),
      ],
    }),
  },
  error: {
    ex: inbox({ error: "unavailable" }),
    tp: inbox({ error: "forbidden" }),
  },
  actionFailed: { ex: inbox({ actions: [action] }), tp: inbox({}) },
  offline: {},
  loading: {},
  empty: {},
} satisfies Record<string, Record<string, InboxState>>;
export type CardScenario = keyof typeof cardScenarios;
export type CardOptions = { scenario: CardScenario; locale: "en" | "de" };

declare global {
  interface Window {
    showCards: (options: CardOptions) => Promise<void>;
    /** Replaces the inbox, e.g. when a request arrives or a recheck answers. */
    setInbox: (scenario: CardScenario) => void;
    /** How long the fake Cloud takes to answer a recheck, and which inbox it answers with. */
    recheckAnswer: (ms: number, scenario: CardScenario) => void;
    rechecks: number;
    expire: () => void;
  }
}

window.showCards = async ({ scenario, locale }) => {
  const clouds = [
    await binding("ex", "Example Cloud", "https://cloud.example.org"),
    await binding("tp", "Team Portal", "https://portal.example.com"),
  ];
  const [states, setStates] = createSignal<Record<string, InboxState>>(cardScenarios[scenario]);
  const [clock, setClock] = createSignal(now);
  const online = scenario !== "offline";
  let answer = { ms: 0, scenario: scenario as CardScenario };
  window.rechecks = 0;
  window.setInbox = (next) => setStates(cardScenarios[next]);
  window.recheckAnswer = (ms, next) => {
    answer = { ms, scenario: next };
  };
  window.expire = () => setClock(Date.parse(until(5)));
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => (scenario === "empty" ? [] : clouds),
    states,
    now: clock,
    online: () => online,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No Cloud in this fixture");
    },
    stored: async () => undefined,
    account: async () => {
      throw new Error("No Cloud in this fixture");
    },
    action: async () => {
      if (scenario === "actionFailed") throw new Error("load failure");
      return action;
    },
    act: noop,
    decide: noop,
    decideChange: noop,
    recheck: async () => {
      window.rechecks++;
      await new Promise((done) => setTimeout(done, answer.ms));
      setStates(cardScenarios[answer.scenario]);
    },
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences: Preferences = {
    locale: () => locale,
    language: () => locale,
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const t = authMessages.resolve([locale]).t;
  render(
    () => (
      <LocaleProvider locale={locale}>
        <MobileShell
          class="auth-app"
          header={
            <MobileShell.Header
              title={t.appName}
              actions={
                <Button variant="ghost" aria-label={t.menu}>
                  <span aria-hidden="true">···</span>
                </Button>
              }
            />
          }
          footer={
            <Show when={scenario !== "empty"}>
              <footer class="auth-footer">
                <p class="auth-recovery">{t.recoveryHelp}</p>
              </footer>
            </Show>
          }
        >
          <Show when={!online}>
            <p role="status">{t.offline}</p>
          </Show>
          <Show
            when={scenario !== "empty"}
            fallback={
              <section class="auth-welcome">
                <img class="auth-mark" src="/favicon.svg" width="80" height="80" alt="" />
                <Placeholder title={t.emptyTitle} description={t.emptyDescription} />
                <Button>{t.addCloud}</Button>
              </section>
            }
          >
            <Clouds auth={auth} preferences={preferences} />
          </Show>
        </MobileShell>
      </LocaleProvider>
    ),
    document.getElementById("root")!,
  );
};
