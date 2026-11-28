import { LocaleProvider } from "@k2b/ui";
import { html, type SiteLocale, siteText } from "./config";
import Speedtest from "./Speedtest.island";

export async function renderPublicPage(locale: SiteLocale, publicUrl: string, stylesheet: string): Promise<Response> {
  const text = siteText[locale];
  const response = await html(
    () => (
      <LocaleProvider locale={locale}>
        <Speedtest server={publicUrl} locale={locale} />
        <noscript>
          <p>{text.noScript}</p>
        </noscript>
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
