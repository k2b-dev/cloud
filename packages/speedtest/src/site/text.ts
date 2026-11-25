/** The words of the public page; shared by the server template and the island, so it imports nothing of the build. */
export const siteText = {
  de: {
    title: "Internet-Speedtest",
    language: "Sprache",
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
    language: "Language",
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
