import { LocaleProvider } from "@k2b/ui";
import { html, type SiteLocale, siteText } from "./config";
import Speedtest from "./Speedtest.island";

export async function renderPublicPage(locale: SiteLocale, publicUrl: string, stylesheet: string): Promise<Response> {
  const text = siteText[locale];
  const response = await html(
    () => (
      <LocaleProvider locale={locale}>
        <main class="speedtest-site">
          <header class="speedtest-site-header">
            <div>
              <p class="speedtest-site-eyebrow">Cloud · Speedtest</p>
              <h1>{text.title}</h1>
              <p>{text.introduction}</p>
            </div>
            <nav aria-label={locale === "de" ? "Sprache" : "Language"}>
              <a href="/de" lang="de" hreflang="de" aria-current={locale === "de" ? "page" : undefined}>
                Deutsch
              </a>
              <a href="/en" lang="en" hreflang="en" aria-current={locale === "en" ? "page" : undefined}>
                English
              </a>
            </nav>
          </header>
          <Speedtest server={publicUrl} />
          <noscript>
            <p>{text.noScript}</p>
          </noscript>
          <footer class="speedtest-site-footer">
            <p>{text.limits}</p>
            <p>{text.privacy}</p>
            <p>
              <a href="https://cloud.k2b.dev" rel="noreferrer">
                {text.promotion}
              </a>
              <span> · {text.promotionDetail}</span>
            </p>
          </footer>
        </main>
      </LocaleProvider>
    ),
    { locale, publicUrl, stylesheet },
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Content-Language", locale);
  response.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  return response;
}
