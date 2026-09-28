/**
 * Request trap for Gotenberg integration tests.
 *
 * Cloud renders HTML offline, so Chromium in Gotenberg must not request
 * anything for it. A test can only show that with a listener Chromium can
 * reach: otherwise "no requests" passes vacuously. `startGotenbergTrap`
 * listens on every host interface and keeps the first address that an
 * unfiltered render actually reached. The candidates are
 * `host.docker.internal` and every non-loopback IPv4 address of this host,
 * which include the Docker bridge gateway of the Gotenberg container, so no
 * Compose or Docker setting is needed. The trap fails when no candidate is
 * reachable.
 *
 * The trap records a request and answers it with 204 No Content, so nothing
 * it serves reaches the printed pages. For a navigation, 204 means Chromium
 * stays on the document: Gotenberg would otherwise print while Chromium
 * replaces the page, and the render would fail or show either page depending
 * on timing. Start one trap per test; a request that arrives after a test
 * has ended then cannot land in the next test's record.
 *
 * The probes name the trap through the common HTML and CSS resource kinds
 * and add a page whenever a script or event handler runs, so the page count
 * shows whether JavaScript ran: an unfiltered `probeDocument` prints three
 * pages, and `probeCss` adds a fourth.
 */
import { networkInterfaces } from "node:os";

export type TrapHtml = { html: string; headerHtml?: string | null; footerHtml?: string | null };

export type GotenbergTrap = {
  /** Trap origin as Chromium in Gotenberg reaches it. */
  origin: string;
  /** Renders HTML with Gotenberg directly, without Cloud's offline mode, as a positive control. */
  renderUnfiltered: (input: TrapHtml) => Promise<Uint8Array>;
  /** Distinct request paths since the previous call, after late requests settle. */
  takeRequests: () => Promise<string[]>;
  stop: () => Promise<void>;
};

const renderUnfiltered = async (gotenbergUrl: string, input: TrapHtml): Promise<Uint8Array> => {
  const form = new FormData();
  form.append("files", new Blob([input.html], { type: "text/html" }), "index.html");
  if (input.headerHtml) form.append("files", new Blob([input.headerHtml], { type: "text/html" }), "header.html");
  if (input.footerHtml) form.append("files", new Blob([input.footerHtml], { type: "text/html" }), "footer.html");
  const response = await fetch(`${gotenbergUrl.replace(/\/+$/, "")}/forms/chromium/convert/html`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gotenberg answered ${response.status}: ${await response.text()}`);
  return new Uint8Array(await response.arrayBuffer());
};

export const startGotenbergTrap = async (gotenbergUrl: string): Promise<GotenbergTrap> => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return new Response(null, { status: 204 });
    },
  });
  const hosts = [
    "host.docker.internal",
    ...Object.values(networkInterfaces())
      .flat()
      .flatMap((address) => (address && address.family === "IPv4" && !address.internal ? [address.address] : [])),
  ];
  try {
    await renderUnfiltered(gotenbergUrl, {
      html: hosts.map((host, index) => `<img src="http://${host}:${server.port}/reach/${index}" width="1" height="1">`).join(""),
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }
  const reached = hosts.findIndex((_, index) => requests.includes(`/reach/${index}`));
  if (reached < 0) {
    await server.stop(true);
    throw new Error(`Gotenberg at ${gotenbergUrl} reached none of ${hosts.join(", ")}; the trap cannot observe its requests.`);
  }
  requests.length = 0;
  return {
    origin: `http://${hosts[reached]}:${server.port}`,
    renderUnfiltered: (input) => renderUnfiltered(gotenbergUrl, input),
    async takeRequests() {
      await Bun.sleep(250);
      const taken = [...new Set(requests)].sort();
      requests.length = 0;
      return taken;
    },
    stop: () => server.stop(true),
  };
};

/** A complete document; `paths` lists what an unfiltered render requests. */
export const probeDocument = (origin: string, label: string): { html: string; paths: string[] } => {
  const at = (path: string) => `${origin}/${label}/${path}`;
  return {
    html: `<!doctype html><html><head>
<base href="${at("base/")}">
<link rel="stylesheet" href="${at("link-stylesheet")}">
<link rel="preload" as="image" href="${at("link-preload")}">
<style>@import url("${at("css-import")}"); @font-face { font-family: probe; src: url("${at("css-font")}"); } .probe { font-family: probe; background-image: url("${at("css-background")}"); }</style>
</head><body>
<p class="probe">${label}</p>
<p style="background-image: url('${at("inline-style")}')">${label}</p>
<img src="${at("img")}" width="8" height="8">
<img srcset="${at("img-srcset")} 1x" width="8" height="8">
<img src="relative" width="8" height="8">
<svg width="8" height="8"><image href="${at("svg-image")}" width="8" height="8"/></svg>
<video poster="${at("video-poster")}" width="8" height="8"></video>
<object data="${at("object")}" width="8" height="8"></object>
<embed src="${at("embed")}" width="8" height="8">
<iframe src="${at("iframe")}" width="8" height="8"></iframe>
<img src="missing.png" width="8" height="8" onerror="this.onerror = null; fetch('${at("event-handler")}'); document.body.insertAdjacentHTML('beforeend', '<p style=&quot;break-before: page&quot;>handler ran</p>')">
<script>fetch("${at("script")}"); document.body.insertAdjacentHTML("beforeend", '<p style="break-before: page">script ran</p>')</script>
</body></html>`,
    paths: [
      "base/relative",
      "base/missing.png",
      "link-stylesheet",
      "link-preload",
      "css-import",
      "css-font",
      "css-background",
      "inline-style",
      "img",
      "img-srcset",
      "svg-image",
      "video-poster",
      "object",
      "embed",
      "iframe",
      "event-handler",
      "script",
    ].map((path) => `/${label}/${path}`),
  };
};

/**
 * A document that navigates to the trap once it loads, which a content
 * policy cannot prevent. The trap's 204 keeps Chromium on the document, so
 * an unfiltered render prints `text` as well and only the request to `path`
 * shows that the document navigated.
 */
export const probeNavigation = (origin: string, label: string): { html: string; path: string; text: string } => ({
  html: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${origin}/${label}/refresh"></head><body><p>${label} stayed local</p></body></html>`,
  path: `/${label}/refresh`,
  text: `${label} stayed local`,
});

/** Page CSS that loads the trap and, by closing its style element, adds a page with a script. */
export const probeCss = (origin: string, label: string): { css: string; paths: string[] } => ({
  css: `@import url("${origin}/${label}/css-import"); body { background-image: url("${origin}/${label}/css-background"); }
</style><script>addEventListener("DOMContentLoaded", () => document.body.insertAdjacentHTML("beforeend", '<p style="break-before: page">page css script ran</p>'))</script><style>`,
  paths: [`/${label}/css-import`, `/${label}/css-background`],
});

/**
 * Header or footer markup that names the trap. Chromium in Gotenberg 8.36
 * loads nothing from header and footer templates, even unfiltered, so this
 * only guards the offline result. Remote stylesheets and fonts are left out because they
 * make Chromium fail to print instead.
 */
export const probeTemplate = (origin: string, label: string): string =>
  `<style>.probe { background-image: url("${origin}/${label}/css-background"); }</style><p class="probe">${label}</p><img src="${origin}/${label}/img" width="8" height="8"><p style="background-image: url('${origin}/${label}/inline-style')">${label}</p><script>fetch("${origin}/${label}/script")</script>`;
