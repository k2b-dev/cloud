import { etag } from "hono/etag";
import { app } from "./config";
import { ADDRESS, LOCALES, type Locale, PAGES } from "./content";
import { Page } from "./Page";
import { LOGO_SVG, SITE_CSS } from "./style";

type Head = { locale: Locale; origin: string };

const LOGO_PATH = `/assets/logo.${Bun.hash(LOGO_SVG).toString(36)}.svg`;
const IMMUTABLE = "public, max-age=31536000, immutable";
// HTML revalidates through its ETag, so a changed page reaches visitors within a minute.
const HTML_CACHE = "public, max-age=60";

const escape = (value: string) => Bun.escapeHTML(value);
const url = (origin: string, locale: Locale) => `${origin}${PAGES[locale].path}`;

const head = ({ locale, origin }: Head): string => {
  const page = PAGES[locale];
  const canonical = url(origin, locale);
  const alternates = LOCALES.map((other) => `<link rel="alternate" hreflang="${other}" href="${escape(url(origin, other))}">`).join("");
  const business = {
    "@context": "https://schema.org",
    "@type": "Bakery",
    name: page.heading,
    url: canonical,
    address: {
      "@type": "PostalAddress",
      streetAddress: ADDRESS.street,
      postalCode: ADDRESS.postalCode,
      addressLocality: ADDRESS.city,
      addressCountry: ADDRESS.country,
    },
  };
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(page.title)}</title>`,
    `<meta name="description" content="${escape(page.description)}">`,
    `<link rel="canonical" href="${escape(canonical)}">`,
    alternates,
    `<link rel="alternate" hreflang="x-default" href="${escape(url(origin, "en"))}">`,
    `<link rel="icon" href="${LOGO_PATH}" type="image/svg+xml">`,
    `<meta property="og:type" content="website"><meta property="og:title" content="${escape(page.title)}">`,
    `<meta property="og:description" content="${escape(page.description)}"><meta property="og:url" content="${escape(canonical)}">`,
    `<meta property="og:locale" content="${locale === "de" ? "de_DE" : "en_GB"}">`,
    // JSON-LD inside a script element must not be able to close it.
    `<script type="application/ld+json">${JSON.stringify(business).replaceAll("<", "\\u003c")}</script>`,
    `<style>${SITE_CSS}</style>`,
  ].join("");
};

const site = app.publicSsr<Head>(
  ({ body, scripts, locale, origin }) =>
    `<!doctype html><html lang="${locale}"><head>${head({ locale, origin })}</head><body>${body}${scripts}</body></html>`,
);

app.public.use("*", etag());

for (const locale of LOCALES) {
  app.public.get(PAGES[locale].path, async (c) => {
    // c.req.url is the visitor's public address, so canonical links follow the domain the operator assigned.
    const origin = new URL(c.req.url).origin;
    const other = locale === "en" ? "de" : "en";
    const response = await site.html(
      () => <Page content={PAGES[locale]} canonical={url(origin, locale)} alternate={PAGES[other].path} logo={LOGO_PATH} />,
      { locale, origin },
    );
    response.headers.set("Cache-Control", HTML_CACHE);
    return response;
  });
}

app.public.get(LOGO_PATH, (c) => c.body(LOGO_SVG, 200, { "Content-Type": "image/svg+xml", "Cache-Control": IMMUTABLE }));

app.public.get("/robots.txt", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.text(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, 200, { "Cache-Control": HTML_CACHE });
});

app.public.get("/sitemap.xml", (c) => {
  const origin = new URL(c.req.url).origin;
  const links = LOCALES.map((locale) => `<xhtml:link rel="alternate" hreflang="${locale}" href="${escape(url(origin, locale))}"/>`).join(
    "",
  );
  const entries = LOCALES.map((locale) => `<url><loc>${escape(url(origin, locale))}</loc>${links}</url>`).join("");
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${entries}</urlset>`,
    200,
    { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": HTML_CACHE },
  );
});

// Moved pages keep their search ranking through a permanent redirect; removed ones say so with 410.
app.public.get("/opening-hours", (c) => c.redirect("/", 301));
app.public.get("/de/oeffnungszeiten", (c) => c.redirect("/de/", 301));
app.public.get("/christmas-2025", (c) => c.html("<!doctype html><title>Gone</title><p>This offer has ended.</p>", 410));
app.public.notFound((c) => c.html('<!doctype html><title>Not found</title><p>Not found. <a href="/">Home</a></p>', 404));
