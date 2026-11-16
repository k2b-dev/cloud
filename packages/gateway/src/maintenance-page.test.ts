import { afterEach, expect, setSystemTime, test } from "bun:test";
import { type MaintenancePageModel, POLL_STEPS, pollDelay, renderMaintenancePage } from "./maintenance-page";

const NOW = Date.parse("2026-11-16T13:58:00+01:00");
const at = (hm: string) => Date.parse(`2026-11-16T${hm}:00+01:00`);
const base = {
  locale: "de" as const,
  cloud: { name: "Musterverein Cloud" },
  timeZone: "Europe/Berlin",
  statusPath: "/_cloud/gateway/status",
};
const MESSAGE = "Wir spielen Version 2.4 ein. Danach ist alles wie vorher.";
const mail = { id: "mail", name: "Mail", accent: "#c2410c" };

afterEach(() => setSystemTime());

const render = (model: MaintenancePageModel, now = NOW) => {
  setSystemTime(new Date(now));
  return renderMaintenancePage(model, { nonce: "n0nce" });
};
/** The visible document without the client script and its templates. */
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, "");
const script = (html: string) => html.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)?.[1] ?? "";
const config = (html: string) =>
  JSON.parse(script(html).match(/\)\((\{[\s\S]*\})\)$/)?.[1] ?? "{}") as {
    state: string;
    views: Record<string, { html: string; say: string }>;
  };
const count = (text: string, part: string) => text.split(part).length - 1;

test("the whole Cloud with note and end shows both, the end printed in the Cloud's zone", () => {
  const html = visible(render({ ...base, kind: "cloud", message: MESSAGE, until: at("14:30") }));
  expect(html).toContain('<html lang="de">');
  expect(count(html, "<h1>")).toBe(1);
  expect(html).toContain("<h1>Wartungsmodus aktiv</h1>");
  expect(html).toContain("Die Cloud wird gerade aktualisiert.");
  expect(html).toContain("Voraussichtlich fertig um <span data-t>14:30 Uhr</span>.");
  expect(html).toContain('<p class="by">Hinweis von deinem Cloud-Team</p><p>Wir spielen Version 2.4 ein.');
  expect(html).toContain("Diese Seite lädt von selbst neu, sobald die Wartung beendet ist.");
  expect(html).toContain('class="tile maint"');
});

test("missing note and end take no space: no empty or placeholder elements are rendered", () => {
  const html = visible(render({ ...base, kind: "cloud" }));
  expect(count(html, 'class="when"')).toBe(1);
  expect(html).not.toContain('class="msg"');
  expect(html).not.toContain("data-t");
  expect(html).not.toContain('class="foot"');
  expect(html).not.toContain('class="btn"');
  // Only the drawn ring and the live region are empty on purpose.
  const empty = [...html.matchAll(/<(\w+)([^>]*)><\/\1>/g)].map((m) => m[0]);
  expect(empty).toEqual(['<span class="ring"></span>', '<p class="sr" id="a" role="status"></p>']);

  const timeOnly = visible(render({ ...base, kind: "cloud", until: at("14:30") }));
  expect(count(timeOnly, 'class="when"')).toBe(2);
  expect(timeOnly).not.toContain('class="msg"');
  const noteOnly = visible(render({ ...base, kind: "cloud", message: `  ${MESSAGE}  ` }));
  expect(count(noteOnly, 'class="when"')).toBe(1);
  expect(noteOnly).toContain(`<p>${MESSAGE}</p>`);
  expect(visible(render({ ...base, kind: "cloud", message: "   " }))).not.toContain('class="msg"');
});

test("an end already in the past is served as taking longer than planned", () => {
  const html = visible(render({ ...base, kind: "cloud", until: at("14:30") }, at("14:41")));
  expect(html).toContain('<span class="dot"></span><span class="word">Dauert länger</span> als geplant (<span data-t>14:30 Uhr</span>).');
  expect(html).toContain("Die Seite prüft weiter und lädt von selbst neu.");
});

test("an end on another day names that day, so an end after midnight is not read as today", () => {
  const tomorrow = Date.parse("2026-11-17T08:00:00+01:00");
  expect(visible(render({ ...base, kind: "cloud", until: tomorrow }))).toContain(
    "Voraussichtlich fertig um <span data-t>08:00 Uhr am 17.11.</span>.",
  );
  expect(visible(render({ ...base, locale: "en", kind: "cloud", until: tomorrow }))).toMatch(/8:00\sAM on Nov 17/);
});

test("English pages use calm English and a 12-hour time", () => {
  const html = visible(render({ ...base, locale: "en", kind: "cloud", message: MESSAGE, until: at("14:30") }));
  expect(html).toContain('<html lang="en">');
  expect(html).toContain("<h1>Maintenance in progress</h1>");
  expect(html).toMatch(/Expected to be done by <span data-t>2:30\sPM<\/span>\./);
  expect(html).toContain("Note from your Cloud team");
});

test("an updating app keeps its icon with the barrier badge and offers the home page", () => {
  const icon = { src: "data:image/png;base64,AAAA" };
  const html = visible(render({ ...base, kind: "app", app: { ...mail, icon }, reason: "updating", homeHref: "/" }));
  expect(html).toContain('<div class="tile app"><img src="data:image/png;base64,AAAA" alt=""><span class="badge">');
  expect(html).toContain("<h1>Mail wird gerade aktualisiert</h1>");
  expect(html).toContain("Das dauert meist unter einer Minute.");
  expect(html).toContain("Der Rest der Cloud läuft weiter.");
  expect(html).toContain('<a class="btn" href="/">Zur Startseite</a>');
  expect(html).toContain(".app{--aa:#c2410c}");
});

test("an app that is simply gone has no badge and says it is unavailable", () => {
  const html = visible(render({ ...base, kind: "app", app: mail, reason: "unavailable", homeHref: "/" }));
  expect(html).not.toContain('class="badge"');
  expect(html).toContain('<div class="tile app"><span aria-hidden="true">M</span></div>');
  expect(html).toContain("<h1>Mail ist gerade nicht erreichbar</h1>");
  expect(html).toContain("Mail startet meist in unter einer Minute neu.");
  expect(html).toContain("Diese Seite lädt von selbst neu, sobald Mail verfügbar ist.");
  const views = config(render({ ...base, kind: "app", app: mail, reason: "unavailable" })).views;
  expect(views.done?.html).toContain("<h1>Mail ist verfügbar</h1>");
  expect(config(render({ ...base, kind: "app", app: mail, reason: "updating" })).views.done?.html).toContain(
    "<h1>Aktualisierung abgeschlossen</h1>",
  );
});

test("app domains and unsafe home links get no home button", () => {
  for (const homeHref of [undefined, "//evil.example", "https://evil.example", "javascript:alert(1)"]) {
    const html = render({ ...base, kind: "app", app: mail, reason: "updating", ...(homeHref ? { homeHref } : {}) });
    expect(html).not.toContain('class="btn"');
    expect(html).not.toContain("Zur Startseite");
  }
});

test("every operator and app string is escaped, in the markup and in the templates", () => {
  const evil = `<img src=x onerror="alert(1)">'&`;
  const html = render({
    ...base,
    cloud: { name: evil, accent: "red;}body{display:none" },
    kind: "app",
    app: { id: `x"&y`, name: evil, accent: "#fff;}*{x:y" },
    reason: "unavailable",
  });
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;");
  const source = script(html);
  expect(source.slice(source.lastIndexOf(")({"))).not.toContain("<");
  expect(html).not.toContain("display:none");
  expect(html).not.toContain("x:y");
  expect(html).toContain("?app=x%22%26y");
  const cloud = render({ ...base, kind: "cloud", message: `</script><script>alert(1)</script>` });
  expect(count(cloud, "<script")).toBe(1);
  expect(visible(cloud)).toContain("&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("every style and script carries the nonce, and nothing loads from elsewhere", () => {
  const html = render({
    ...base,
    cloud: { name: "Musterverein Cloud", logo: { src: "https://cdn.example/logo.png" } },
    kind: "app",
    app: { ...mail, icon: { src: "//cdn.example/icon.svg" } },
    reason: "updating",
    homeHref: "/",
  });
  expect(count(html, "<style")).toBe(count(html, '<style nonce="n0nce">'));
  expect(count(html, "<script")).toBe(count(html, '<script nonce="n0nce">'));
  expect(count(html, "<script")).toBe(1);
  expect(html).not.toMatch(/https?:|\/\/cdn|url\(|@import|<link|style="/);
  expect(html).not.toContain("<img");
  expect(renderMaintenancePage({ ...base, kind: "cloud" }, { nonce: `a"b` })).toContain('nonce="a&quot;b"');
});

test("the first paint equals the client's template for the same state", () => {
  for (const model of [
    { ...base, kind: "cloud", message: MESSAGE, until: at("14:30") },
    { ...base, kind: "cloud" },
    { ...base, kind: "app", app: mail, reason: "updating", homeHref: "/" },
  ] satisfies MaintenancePageModel[]) {
    const html = render(model);
    const { state, views } = config(html);
    const markup = html.match(/<div id="v">([\s\S]*?)<\/div><\/main>/)?.[1];
    expect(markup).toBe(views[state]?.html.replace("<span data-t></span>", "<span data-t>14:30 Uhr</span>"));
  }
});

test("the poll schedule slows down over time and spreads by 20 %", () => {
  expect(POLL_STEPS.cloud).toEqual([
    [0, 5_000],
    [120_000, 15_000],
    [600_000, 30_000],
  ]);
  expect(pollDelay("cloud", 0, 0.5)).toBe(5_000);
  expect(pollDelay("cloud", 119_999, 0.5)).toBe(5_000);
  expect(pollDelay("cloud", 120_000, 0.5)).toBe(15_000);
  expect(pollDelay("cloud", 600_000, 0.5)).toBe(30_000);
  expect(pollDelay("app", 0, 0.5)).toBe(2_000);
  expect(pollDelay("app", 30_000, 0.5)).toBe(5_000);
  expect(pollDelay("app", 120_000, 0.5)).toBe(15_000);
  expect(pollDelay("cloud", 0, 0)).toBe(4_000);
  expect(pollDelay("cloud", 0, 0.999_999)).toBeCloseTo(6_000, 0);
});

test("the page stays small: under 12 KB gzip with a long note and a logo", () => {
  const html = render({
    ...base,
    cloud: { name: "Musterverein Cloud", logo: { src: `data:image/png;base64,${"A".repeat(1_000)}` } },
    kind: "cloud",
    message: "Wir spielen Version 2.4 ein. ".repeat(20),
    until: at("14:30"),
  });
  expect(Bun.gzipSync(html).length).toBeLessThan(12 * 1024);
});

type Timer = { fn: () => void; ms: number; id: number };

/** Runs the page's own client script against small stand-ins for the browser. */
const runClient = (html: string, answer: () => Promise<unknown>) => {
  const v = { innerHTML: "", contains: () => false, querySelector: () => null };
  const a = { textContent: "" };
  const timers: Timer[] = [];
  const listeners: Record<string, () => void> = {};
  const urls: string[] = [];
  const location = { reloads: 0, reload: () => location.reloads++ };
  let next = 0;
  const document = {
    getElementById: (id: string) => (id === "v" ? v : a),
    activeElement: null,
    visibilityState: "visible",
    addEventListener: (type: string, fn: () => void) => {
      listeners[`document:${type}`] = fn;
    },
  };
  const fetch = (url: string) => {
    urls.push(url);
    return answer().then((body) => ({ ok: true, json: () => Promise.resolve(body) }));
  };
  const setTimeout = (fn: () => void, ms: number) => {
    timers.push({ fn, ms, id: ++next });
    return next;
  };
  const clearTimeout = (id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  };
  const addEventListener = (type: string, fn: () => void) => {
    listeners[type] = fn;
  };
  new Function("document", "fetch", "setTimeout", "clearTimeout", "addEventListener", "location", script(html))(
    document,
    fetch,
    setTimeout,
    clearTimeout,
    addEventListener,
    location,
  );
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { v, a, timers, listeners, urls, location, settle };
};

test("the client swaps a moved end in place, shows a lost connection, then reloads after the end", async () => {
  setSystemTime(new Date(NOW));
  const html = renderMaintenancePage({ ...base, kind: "cloud", message: MESSAGE, until: at("14:30") }, { nonce: "n" });
  let answer: () => Promise<unknown> = () => Promise.resolve({ maintenance: { active: true, until: new Date(at("15:00")).toISOString() } });
  const page = runClient(html, () => answer());
  const first = page.timers.find((timer) => timer.ms >= 4_000 && timer.ms <= 6_000);
  expect(first).toBeDefined();
  expect(page.v.innerHTML).toBe("");

  page.listeners.online?.();
  await page.settle();
  expect(page.urls).toEqual(["/_cloud/gateway/status"]);
  expect(page.v.innerHTML).toContain("Neues Ende: voraussichtlich <span data-t>15:00 Uhr</span>.");
  expect(page.a.textContent).toBe("Wartungsmodus aktiv. Die Seite prüft weiter und lädt von selbst neu.");

  answer = () => Promise.reject(new TypeError("offline"));
  page.listeners["document:visibilitychange"]?.();
  await page.settle();
  expect(page.v.innerHTML).toContain("<h1>Keine Verbindung zur Cloud</h1>");
  expect(page.v.innerHTML).toContain("Zuletzt erreicht um <span data-t>13:58 Uhr</span>.");

  answer = () => Promise.resolve({ maintenance: null });
  page.listeners.online?.();
  await page.settle();
  expect(page.v.innerHTML).toContain("<h1>Wartung beendet</h1>");
  const reload = page.timers.find((timer) => String(timer.fn).includes("reload"));
  expect(reload?.ms).toBeGreaterThanOrEqual(0);
  expect(reload?.ms).toBeLessThan(3_000);
  reload?.fn();
  expect(page.location.reloads).toBe(1);
});

test("an app page asks for its app and waits until it is available outside maintenance", async () => {
  setSystemTime(new Date(NOW));
  const html = renderMaintenancePage({ ...base, kind: "app", app: mail, reason: "updating" }, { nonce: "n" });
  let answer: () => Promise<unknown> = () => Promise.resolve({ maintenance: null, app: { available: false } });
  const page = runClient(html, () => answer());
  expect(page.timers.some((timer) => timer.ms >= 1_600 && timer.ms <= 2_400)).toBe(true);

  page.listeners.online?.();
  await page.settle();
  expect(page.urls).toEqual(["/_cloud/gateway/status?app=mail"]);
  expect(page.v.innerHTML).toBe("");

  page.timers.find((timer) => timer.ms === 120_000)?.fn();
  expect(page.v.innerHTML).toContain('<span class="word">Dauert länger</span> als üblich.');
  expect(page.v.innerHTML).not.toContain('class="badge"');

  answer = () => Promise.resolve({ maintenance: { active: true, until: null }, app: { available: true } });
  page.listeners.online?.();
  await page.settle();
  expect(page.v.innerHTML).not.toContain("Aktualisierung abgeschlossen");

  answer = () => Promise.resolve({ maintenance: null, app: { available: true } });
  page.listeners.online?.();
  await page.settle();
  expect(page.v.innerHTML).toContain("<h1>Aktualisierung abgeschlossen</h1>");
});
