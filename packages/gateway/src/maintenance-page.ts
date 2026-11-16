/**
 * The page the gateway serves instead of "Service unavailable": the whole Cloud is in maintenance, or one app is
 * restarting. One self-contained document with a nonce'd style and script; its only request polls `statusPath`.
 *
 * The server renders every state the page can reach. The first one is the markup, the others travel as templates
 * the client swaps in place, so the first paint and every later state come from the same code.
 */

export type MaintenancePageImage = { src: string /* data: URI */ };
export type MaintenancePageModel = {
  locale: "de" | "en";
  cloud: { name: string; logo?: MaintenancePageImage; accent?: string };
  timeZone: string; // IANA, for printing `until`
  statusPath: string; // "/_cloud/gateway/status"
} & (
  | { kind: "cloud"; message?: string; until?: number /* epoch ms */ }
  | {
      kind: "app";
      app: { id: string; name: string; icon?: MaintenancePageImage; accent?: string };
      reason: "updating" | "unavailable";
      homeHref?: string /* "/" on the Cloud host; absent on app domains */;
    }
);

type Kind = MaintenancePageModel["kind"];

/** Status polling: `[from elapsed ms, delay ms]`, first match from the end wins. Each delay varies by ±20 %. */
export const POLL_STEPS: Record<Kind, readonly (readonly [number, number])[]> = {
  cloud: [
    [0, 5_000],
    [120_000, 15_000],
    [600_000, 30_000],
  ],
  app: [
    [0, 2_000],
    [30_000, 5_000],
    [120_000, 15_000],
  ],
};

/** How long an app page waits before it says that the restart takes longer than usual. */
export const APP_LONG_AFTER_MS = 120_000;

/** Delay before the next status check, `elapsedMs` after the page loaded; `random` in [0, 1). */
export const pollDelay = (kind: Kind, elapsedMs: number, random: number): number => {
  let delay = 0;
  for (const [from, ms] of POLL_STEPS[kind]) if (elapsedMs >= from || delay === 0) delay = ms;
  return delay * (0.8 + 0.4 * random);
};

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;
const accent = (value: string | undefined): string | null => (value && HEX.test(value) ? value : null);
const image = (value: MaintenancePageImage | undefined): string | null => (value && DATA_IMAGE.test(value.src) ? value.src : null);
const initial = (name: string): string => esc((Array.from(name.trim())[0] ?? "?").toLocaleUpperCase());

/** White or near-black letter, whichever reads better on the accent. */
const letterOn = (hex: string): string => {
  const full = hex.length <= 5 ? [...hex.slice(1, 4)].map((c) => c + c).join("") : hex.slice(1, 7);
  const lin = [0, 2, 4].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * (lin[0] ?? 0) + 0.7152 * (lin[1] ?? 0) + 0.0722 * (lin[2] ?? 0);
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? "#fff" : "#09090b";
};

/** Tabler `ti-barrier-block` (outline, @tabler/icons 3.50.0). */
const BARRIER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v7a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1l0 -7"/><path d="M7 16v4M7.5 16l9 -9M13.5 16l6.5 -6.5M4 13.5l6.5 -6.5M17 16v4M5 20h4M15 20h4M17 7v-2M7 7v-2"/></svg>';
const CHECK =
  '<svg viewBox="0 0 24 24" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';

/** Where the client writes a time; the server fills it for the first paint. */
const T = (text: string): string => `<span data-t>${esc(text)}</span>`;
const LATE_WORD = (word: string): string => `<span class="dot"></span><span class="word">${word}</span>`;

const TEXT = {
  de: {
    maint: "Wartungsmodus aktiv",
    updating: "Die Cloud wird gerade aktualisiert.",
    until: (t: string) => `Voraussichtlich fertig um ${t}.`,
    late: (t: string) => `${LATE_WORD("Dauert länger")} als geplant (${t}).`,
    moved: (t: string) => `Neues Ende: voraussichtlich ${t}.`,
    by: "Hinweis von deinem Cloud-Team",
    reloads: "Diese Seite lädt von selbst neu, sobald die Wartung beendet ist.",
    keepsChecking: "Die Seite prüft weiter und lädt von selbst neu.",
    done: "Wartung beendet",
    loading: "Seite wird geladen …",
    offline: "Keine Verbindung zur Cloud",
    offlineLine: "Dein Gerät erreicht die Cloud gerade nicht.",
    offlineHint: "Prüfe WLAN oder mobile Daten. Während einer Wartung kann die Cloud kurz nicht erreichbar sein.",
    offlineLive: "Die Seite versucht es von selbst weiter.",
    lastReached: (t: string) => `Zuletzt erreicht um ${t}.`,
    appUpdating: (n: string) => `${n} wird gerade aktualisiert`,
    appUpdatingLine: "Das dauert meist unter einer Minute.",
    appUpdatingLive: "Diese Seite lädt von selbst neu, sobald die Aktualisierung abgeschlossen ist.",
    appDown: (n: string) => `${n} ist gerade nicht erreichbar`,
    appDownLine: (n: string) => `${n} startet meist in unter einer Minute neu.`,
    appDownLive: (n: string) => `Diese Seite lädt von selbst neu, sobald ${n} verfügbar ist.`,
    appLong: `${LATE_WORD("Dauert länger")} als üblich.`,
    rest: "Der Rest der Cloud läuft weiter.",
    restLong: "Der Rest der Cloud läuft weiter. Bleibt es so, sag deinem Cloud-Team Bescheid.",
    appUpdated: "Aktualisierung abgeschlossen",
    appBack: (n: string) => `${n} ist verfügbar`,
    home: "Zur Startseite",
  },
  en: {
    maint: "Maintenance in progress",
    updating: "The Cloud is being updated.",
    until: (t: string) => `Expected to be done by ${t}.`,
    late: (t: string) => `${LATE_WORD("Taking longer")} than planned (${t}).`,
    moved: (t: string) => `New end: expected by ${t}.`,
    by: "Note from your Cloud team",
    reloads: "This page reloads on its own once maintenance is over.",
    keepsChecking: "The page keeps checking and reloads on its own.",
    done: "Maintenance finished",
    loading: "Loading page …",
    offline: "No connection to the Cloud",
    offlineLine: "Your device cannot reach the Cloud right now.",
    offlineHint: "Check Wi-Fi or mobile data. During maintenance the Cloud can be out of reach for a moment.",
    offlineLive: "The page keeps trying on its own.",
    lastReached: (t: string) => `Last reached at ${t}.`,
    appUpdating: (n: string) => `${n} is being updated`,
    appUpdatingLine: "This usually takes less than a minute.",
    appUpdatingLive: "This page reloads on its own once the update is finished.",
    appDown: (n: string) => `${n} is not available right now`,
    appDownLine: (n: string) => `${n} usually restarts in less than a minute.`,
    appDownLive: (n: string) => `This page reloads on its own once ${n} is available.`,
    appLong: `${LATE_WORD("Taking longer")} than usual.`,
    rest: "The rest of the Cloud keeps running.",
    restLong: "The rest of the Cloud keeps running. If it stays like this, let your Cloud team know.",
    appUpdated: "Update finished",
    appBack: (n: string) => `${n} is available`,
    home: "Go to home page",
  },
} as const;

/** Time of day in the Cloud's zone. The client uses the same options for times it learns later. */
const timeFormat = (locale: "de" | "en") =>
  locale === "de"
    ? {
        options: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const,
        suffix: " Uhr",
        day: { prefix: " am ", options: { day: "numeric", month: "numeric" } as const },
      }
    : {
        options: { hour: "numeric", minute: "2-digit" } as const,
        suffix: "",
        day: { prefix: " on ", options: { month: "short", day: "numeric" } as const },
      };

/** Calendar day in `zone`, to name the day of a time that is not today. */
const DAY_KEY = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

type Live = "ring" | "pause" | "check";
type View = {
  tile: string; // html, may be empty
  heading: string; // text
  lines: string[]; // html
  message?: { by?: string; text: string }; // text
  live: Live;
  status: string; // text
  home?: { href: string; label: string };
  foot?: string; // html
};

const CSS = `:root{color-scheme:light dark;--surface:#fff;--muted:#f4f4f5;--text:#09090b;--text2:#27272a;--text3:#45454e;--subtle:#71717a;--edge:#d4d4d8;--action:#1d4ed8;--focus:#3b82f6;--ok:#059669;--warn:#d97706;--warn-bg:#fffbeb;--warn-text:#92400e;--tint:8%;--ca:#0f766e;--cf:#fff;--aa:var(--text3)}
@media (prefers-color-scheme:dark){:root{--surface:#18181b;--muted:#222226;--text:#fafafa;--text2:#e4e4e7;--text3:#c4c4cc;--subtle:#9a9aa5;--edge:#3f3f46;--action:#3b82f6;--focus:#60a5fa;--ok:#10b981;--warn:#f59e0b;--warn-bg:#2b1d05;--warn-text:#fcd34d;--tint:20%}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--surface);color:var(--text);font-size:15px;line-height:1.5}
.mp{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;padding:22px 28px}
#v{display:contents}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px;color:var(--text2)}
.logo{width:28px;height:28px;border-radius:8px;background:var(--ca);color:var(--cf);display:grid;place-items:center;font-weight:700;font-size:14px;flex:none;overflow:hidden}
.logo img{width:100%;height:100%;object-fit:cover}
.mid{margin:auto 0;width:100%;max-width:31rem;align-self:center}
.tile{position:relative;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;margin-bottom:18px}
.tile svg,.tile img{width:24px;height:24px}
.maint{background:var(--warn-bg);color:var(--warn)}
.app{background:color-mix(in srgb,var(--aa) var(--tint),var(--surface));color:var(--aa);font-size:18px;font-weight:650}
.badge{position:absolute;right:-9px;bottom:-9px;width:26px;height:26px;border-radius:50%;background:var(--warn-bg);color:var(--warn);box-shadow:0 0 0 2px var(--surface);display:grid;place-items:center}
.tile .badge svg{width:17px;height:17px}
h1{font-size:26px;line-height:1.2;letter-spacing:-.02em;font-weight:650;margin:0}
.when{font-size:16px;color:var(--text2);margin:8px 0 0}
.when+.when{margin-top:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warn);margin-right:8px;vertical-align:middle;position:relative;top:-1px}
.word{font-weight:600;color:var(--warn-text)}
.msg{margin:20px 0 0}.msg p{margin:0;color:var(--text2);white-space:pre-line}
.msg .by{font-size:13px;color:var(--subtle);margin:0 0 3px}
.live{display:flex;gap:12px;align-items:center;margin-top:24px}
.t{flex:1;min-width:0;font-size:14px;color:var(--text3)}
.ring,.check{width:18px;height:18px;border-radius:50%;flex:none;align-self:flex-start;margin-top:2px}
.ring{border:2px solid var(--edge);border-top-color:var(--action);animation:spin 1.1s linear infinite}
.ring.pause{animation:none;border-top-color:var(--edge)}
.check{background:var(--ok);display:grid;place-items:center}.check svg{width:12px;height:12px;stroke:#fff}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ring{animation:none}}
.btn{font:inherit;font-size:14px;font-weight:550;height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--edge);background:var(--surface);color:var(--text);white-space:nowrap;display:inline-flex;align-items:center;text-decoration:none}
.btn:hover{background:var(--muted)}.btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.foot{font-size:13px;color:var(--subtle);margin:0}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (max-width:640px){.mp{padding:16px 22px 22px}h1{font-size:23px}.live{flex-wrap:wrap;align-content:flex-start}.t{flex:1 1 calc(100% - 30px)}.btn{margin-left:30px}}`;

/**
 * The client, as plain source so no bundler rewrites it. It polls the status, swaps prepared states into `#v`,
 * announces each new state once, and reloads after the end with up to 3 s of spread.
 */
const CLIENT = `(c)=>{const v=document.getElementById("v"),a=document.getElementById("a"),t0=Date.now(),skew=c.now-t0;
let until=c.until,cur=c.state,shown=c.time,ok=true,long=false,last=t0,busy=false,done=false,timer=0,lateTimer=0;
const now=()=>Date.now()+skew,esc=s=>s.replace(/[&<>"']/g,ch=>"&#"+ch.charCodeAt(0)+";"),
part=(o,ms)=>new Intl.DateTimeFormat(c.locale,Object.assign({timeZone:c.zone},o)).format(ms),
fmt=ms=>part(c.options,ms)+c.suffix+(part(c.dayKey,ms)===part(c.dayKey,now())?"":c.day.prefix+part(c.day.options,ms)),
delay=e=>{let d=c.steps[0][1];for(const s of c.steps)if(e>=s[0])d=s[1];return d*(0.8+0.4*Math.random())},
show=(k,t)=>{if(k===cur&&t===shown)return;const f=c.views[k],el=document.activeElement,refocus=!!el&&v.contains(el)&&el.classList.contains("btn");
v.innerHTML=f.html.split("<span data-t></span>").join("<span data-t>"+esc(t)+"</span>");if(k!==cur)a.textContent=f.say;cur=k;shown=t;
if(refocus){const b=v.querySelector(".btn");if(b)b.focus()}},
render=()=>{if(done)return;clearTimeout(lateTimer);if(!ok)return show("offline",fmt(last+skew));
if(c.kind==="app")return show(long?"long":"base","");if(until==null)return show("plain","");
const t=until===c.until?c.untilText:fmt(until);if(now()>=until)return show("late",t);
lateTimer=setTimeout(render,Math.min(until-now()+50,2147483647));show(until===c.until?"active":"moved",t)},
poll=()=>{clearTimeout(timer);if(busy||done)return;busy=true;const ctl=new AbortController(),kill=setTimeout(()=>ctl.abort(),10000);
fetch(c.url,{cache:"no-store",signal:ctl.signal}).then(r=>{if(!r.ok)throw new Error(String(r.status));return r.json()}).then(j=>{
ok=true;last=Date.now();const m=j&&j.maintenance,on=!!(m&&m.active);
if(c.kind==="cloud"?!on:!on&&!!j.app&&j.app.available===true){clearTimeout(lateTimer);done=true;show("done","");setTimeout(()=>location.reload(),Math.random()*3000);return}
if(c.kind==="cloud"){const u=m.until?Date.parse(m.until):NaN;until=Number.isNaN(u)?null:u}render()})
.catch(()=>{ok=false;render()}).finally(()=>{clearTimeout(kill);busy=false;if(!done)timer=setTimeout(poll,delay(Date.now()-t0))})};
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")poll()});
addEventListener("online",poll);addEventListener("offline",()=>{ok=false;render()});
if(c.kind==="app")setTimeout(()=>{long=true;render()},c.long);
render();timer=setTimeout(poll,delay(0))}`;

const ring = (live: Live): string =>
  live === "check" ? `<span class="check">${CHECK}</span>` : `<span class="ring${live === "pause" ? " pause" : ""}"></span>`;

const fragment = (view: View): string => {
  const lines = view.lines.map((line) => `<p class="when">${line}</p>`).join("");
  const message = view.message
    ? `<div class="msg">${view.message.by ? `<p class="by">${esc(view.message.by)}</p>` : ""}<p>${esc(view.message.text)}</p></div>`
    : "";
  const home = view.home ? `<a class="btn" href="${esc(view.home.href)}">${esc(view.home.label)}</a>` : "";
  const foot = view.foot ? `<p class="foot">${view.foot}</p>` : "";
  return `<div class="mid">${view.tile}<h1>${esc(view.heading)}</h1>${lines}${message}<div class="live">${ring(view.live)}<span class="t">${esc(view.status)}</span>${home}</div></div>${foot}`;
};

type CloudState = "plain" | "active" | "late" | "moved" | "offline" | "done";
type AppState = "base" | "long" | "offline" | "done";

const offlineView = (tx: (typeof TEXT)[keyof typeof TEXT], t: string): View => ({
  tile: "",
  heading: tx.offline,
  lines: [tx.offlineLine],
  message: { text: tx.offlineHint },
  live: "pause",
  status: tx.offlineLive,
  foot: tx.lastReached(t),
});

const cloudViews = (tx: (typeof TEXT)[keyof typeof TEXT], message: string | undefined, t: string): Record<CloudState, View> => {
  const tile = `<div class="tile maint">${BARRIER}</div>`;
  const note = message ? { by: tx.by, text: message } : undefined;
  const active = (line: string | null, status: string): View => ({
    tile,
    heading: tx.maint,
    lines: line ? [tx.updating, line] : [tx.updating],
    ...(note ? { message: note } : {}),
    live: "ring",
    status,
  });
  return {
    plain: active(null, tx.reloads),
    active: active(tx.until(t), tx.reloads),
    late: active(tx.late(t), tx.keepsChecking),
    moved: active(tx.moved(t), tx.keepsChecking),
    offline: offlineView(tx, t),
    done: { tile, heading: tx.done, lines: [], live: "check", status: tx.loading },
  };
};

const appViews = (
  tx: (typeof TEXT)[keyof typeof TEXT],
  model: Extract<MaintenancePageModel, { kind: "app" }>,
  t: string,
): Record<AppState, View> => {
  const name = model.app.name;
  const icon = image(model.app.icon);
  const glyph = icon ? `<img src="${esc(icon)}" alt="">` : `<span aria-hidden="true">${initial(name)}</span>`;
  const tile = (badge: boolean) => `<div class="tile app">${glyph}${badge ? `<span class="badge">${BARRIER}</span>` : ""}</div>`;
  const href = model.homeHref?.startsWith("/") && !model.homeHref.startsWith("//") ? model.homeHref : null;
  const home = href ? { home: { href, label: tx.home } } : {};
  const updating = model.reason === "updating";
  return {
    base: {
      tile: tile(updating),
      heading: updating ? tx.appUpdating(name) : tx.appDown(name),
      lines: [updating ? tx.appUpdatingLine : tx.appDownLine(esc(name))],
      message: { text: tx.rest },
      live: "ring",
      status: updating ? tx.appUpdatingLive : tx.appDownLive(name),
      ...home,
    },
    long: {
      tile: tile(false),
      heading: tx.appDown(name),
      lines: [tx.appLong],
      message: { text: tx.restLong },
      live: "ring",
      status: tx.keepsChecking,
      ...home,
    },
    offline: offlineView(tx, t),
    done: {
      tile: tile(false),
      heading: updating ? tx.appUpdated : tx.appBack(name),
      lines: [],
      live: "check",
      status: tx.loading,
    },
  };
};

const validZone = (zone: string): string => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
};

const EMPTY_T = "<span data-t></span>";

/** One self-contained HTML document; every model string is escaped and only `data:` images are used. */
export const renderMaintenancePage = (model: MaintenancePageModel, options: { nonce: string }): string => {
  const now = Date.now();
  const tx = TEXT[model.locale];
  const zone = validZone(model.timeZone);
  const format = timeFormat(model.locale);
  const part = (options: Intl.DateTimeFormatOptions, ms: number) =>
    new Intl.DateTimeFormat(model.locale, { timeZone: zone, ...options }).format(ms);
  // A time on another day names that day, so an end after midnight is not read as today.
  const fmt = (ms: number) =>
    part(format.options, ms) +
    format.suffix +
    (part(DAY_KEY, ms) === part(DAY_KEY, now) ? "" : format.day.prefix + part(format.day.options, ms));
  const nonce = esc(options.nonce);

  let first: View;
  let templates: Record<string, View>;
  let state: CloudState | AppState;
  let time = "";
  let until: number | null = null;
  if (model.kind === "cloud") {
    const message = model.message?.trim() || undefined;
    until = typeof model.until === "number" && Number.isFinite(model.until) ? model.until : null;
    time = until === null ? "" : fmt(until);
    const cloudState: CloudState = until === null ? "plain" : now >= until ? "late" : "active";
    state = cloudState;
    first = cloudViews(tx, message, T(time))[cloudState];
    templates = cloudViews(tx, message, EMPTY_T);
  } else {
    state = "base";
    first = appViews(tx, model, "").base;
    templates = appViews(tx, model, EMPTY_T);
  }

  const cloudAccent = accent(model.cloud.accent);
  const appAccent = model.kind === "app" ? accent(model.app.accent) : null;
  const vars = `${cloudAccent ? `:root{--ca:${cloudAccent};--cf:${letterOn(cloudAccent)}}` : ""}${appAccent ? `.app{--aa:${appAccent}}` : ""}`;
  const logo = image(model.cloud.logo);
  const brand = `<div class="brand"><span class="logo" aria-hidden="true">${
    logo ? `<img src="${esc(logo)}" alt="">` : initial(model.cloud.name)
  }</span><span>${esc(model.cloud.name)}</span></div>`;

  const config = {
    kind: model.kind,
    url: model.kind === "app" ? `${model.statusPath}?app=${encodeURIComponent(model.app.id)}` : model.statusPath,
    locale: model.locale,
    zone,
    options: format.options,
    suffix: format.suffix,
    day: format.day,
    dayKey: DAY_KEY,
    now,
    until,
    untilText: time,
    state,
    time,
    steps: POLL_STEPS[model.kind],
    long: APP_LONG_AFTER_MS,
    views: Object.fromEntries(
      Object.entries(templates).map(([key, view]) => [key, { html: fragment(view), say: `${view.heading}. ${view.status}` }]),
    ),
  };
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  const title = model.kind === "cloud" ? tx.maint : first.heading;

  return `<!doctype html><html lang="${model.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(model.cloud.name)}</title><style nonce="${nonce}">${CSS}${vars}</style></head><body><main class="mp">${brand}<div id="v">${fragment(first)}</div></main><p class="sr" id="a" role="status"></p><script nonce="${nonce}">(${CLIENT})(${json})</script></body></html>`;
};
