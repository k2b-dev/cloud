import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

export const siteText = {
  de: {
    title: "Internet-Speedtest",
    description: "Miss Download, Upload und Latenz in höchstens 14 Sekunden. Ohne Anmeldung, Cookies oder Tracking.",
    introduction: "Miss Download, Upload und Latenz zu diesem Server.",
    limits: "Höchstens 2 Tests pro Minute je Internetzugang. Eine Messung kann viele Daten übertragen; beachte deinen Datentarif.",
    privacy:
      "Keine Cookies. Kein Tracking. Der Server verwendet deine IP-Adresse kurzzeitig für das Testlimit und speichert keine Ergebnisse.",
    promotion: "Gemacht mit Cloud",
    promotionDetail: "Deine Anwendungen. Deine Infrastruktur.",
    noScript:
      "Für die Messung brauchst du JavaScript. Alternativ kannst du das Skript unter /cli herunterladen und mit Node oder Bun ausführen.",
  },
  en: {
    title: "Internet speed test",
    description: "Measure download, upload and latency in up to 14 seconds. No account, cookies or tracking.",
    introduction: "Measure download, upload and latency to this server.",
    limits: "Up to 2 tests per minute per internet connection. A test can transfer a lot of data; check your data allowance.",
    privacy: "No cookies. No tracking. The server briefly uses your IP address for the test limit and stores no results.",
    promotion: "Made with Cloud",
    promotionDetail: "Your applications. Your infrastructure.",
    noScript: "Measurement requires JavaScript. Alternatively, download the script at /cli and run it with Node or Bun.",
  },
};
export type SiteLocale = keyof typeof siteText;
const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const { config, plugin, html } = createConfig<{ locale: SiteLocale; publicUrl: string; stylesheet: string }>({
  rootDir: resolve(import.meta.dir, ".."),
  componentRoots: ["site"],
  errorFallback: "site/IslandError.tsx",
  template: ({ body, scripts, locale, publicUrl, stylesheet }) => {
    const text = siteText[locale];
    return `<!doctype html><html lang="${locale}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<script>document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)</script>
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>${text.title} · Cloud</title><meta name="description" content="${escapeHtml(text.description)}">
<link rel="canonical" href="${escapeHtml(publicUrl)}/${locale}">
<link rel="alternate" hreflang="de" href="${escapeHtml(publicUrl)}/de"><link rel="alternate" hreflang="en" href="${escapeHtml(publicUrl)}/en">
<link rel="stylesheet" href="/assets/${escapeHtml(stylesheet)}"><link rel="icon" href="data:,">
</head><body class="k2b-ui">${body}${scripts}</body></html>`;
  },
});
