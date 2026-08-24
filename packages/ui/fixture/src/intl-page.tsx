import { LocaleProvider } from "@k2b/ui";
import { ssr } from "./config";
import IntlDemo from "./IntlSection.island";

/**
 * Locale coherence page: the server provider and the emitted `<html lang>`
 * carry the same locale, so the two independent island roots re-render in the
 * browser with identical text via the `<html lang>` fallback.
 */
export default ssr((context) => {
  const locale = context.req.query("locale") ?? "de";
  const page = context.get("page");
  page.title = "@k2b/ui intl fixture";
  page.lang = locale;

  return () => (
    <main class="k2b-ui" style={{ display: "grid", gap: "16px", padding: "24px" }}>
      <LocaleProvider locale={locale}>
        <IntlDemo />
        <IntlDemo />
      </LocaleProvider>
    </main>
  );
});
