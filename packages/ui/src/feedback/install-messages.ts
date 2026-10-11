import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const installMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      installApp: "Install app",
      installNative: ({ appName }: { appName: string }) =>
        `Your browser can install ${appName}. Confirm installation in the dialog that opens next.`,
      installRequested: "Installation requested. Follow your browser’s instructions.",
      installFailed: "The installation dialog could not be opened.",
      installOpenShare: "Open Share",
      installOpenShareDetail: "Tap the Share button in Safari. It may be inside the More menu.",
      installHomeScreen: "Add to Home Screen",
      installHomeScreenDetail: "Scroll through the actions and choose “Add to Home Screen”.",
      installConfirmAdd: "Confirm Add",
      installConfirmAddDetail: "Keep “Open as Web App” enabled if shown, then tap “Add”.",
      installOpenShareBrowserDetail: "In Chrome, tap Share in the address bar. In Firefox or Edge, open the menu, then Share.",
      installSafariFallback: "Don’t see “Add to Home Screen”? This page may be open inside another app. Open it in Safari.",
      installSafariMenu: "Open the Safari menu",
      installSafariMenuDetail: "On your Mac, open File or click Share in Safari.",
      installAddDock: "Add to Dock",
      installAddDockDetail: "Choose “Add to Dock”, then confirm “Add”. Available in Safari on macOS Sonoma or later.",
      installBrowserMenu: "Open the browser menu",
      installBrowserMenuDetail: "Use the menu beside the address bar.",
      installAndroidDetail: "Choose “Install app” or “Add to Home screen”, then follow the browser’s instructions.",
      installBrowserDetail: "Look for “Install app” in the menu or an installation icon in the address bar.",
      installUnavailable: "No installation option? You can keep using the browser or try another browser that supports installation.",
      installAppleInAppTitle: "Open this page in Safari",
      installAppleInAppDetail: ({ appName }: { appName: string }) =>
        `This page is open inside another app, which can’t install ${appName}. In that app’s menu (••• or Share), choose “Open in Safari”, or copy the link and paste it into Safari.`,
      installInAppTitle: "Open this page in your browser",
      installInAppDetail: ({ appName }: { appName: string }) =>
        `This page is open inside another app, which can’t install ${appName}. In that app’s menu, choose “Open in Chrome” or “Open in browser”, or copy the link and paste it into Chrome.`,
      installAppleBrowserTitle: "Safari works best",
      installAppleBrowserDetail: "This browser installs through Share → Add to Home Screen. If that isn’t there, open this page in Safari.",
      installAndroidBrowserTitle: "Chrome works best",
      installAndroidBrowserDetail:
        "In this browser, look for “Install” or “Add to Home screen” in the menu. If that isn’t there, open this page in Chrome.",
      installSamsungTitle: "Install with Chrome",
      installSamsungDetail: ({ appName }: { appName: string }) =>
        `On Samsung phones, Samsung Internet builds its own app package, which Android 14 and later may block as “built for an older version of Android”. That warning is about the package, not about ${appName}. Chrome installs ${appName} without it. Without Chrome, use this browser’s menu and continue through that warning.`,
      installOpenChrome: "Open in Chrome",
      installCopyLink: "Copy link",
      installLinkCopied: "Link copied",
      installCopyFailed: "The link could not be copied. Copy this address manually:",
    },
    de: {
      installApp: "App installieren",
      installNative: ({ appName }) => `Dein Browser kann ${appName} installieren. Bestätige die Installation im nächsten Dialog.`,
      installRequested: "Installation angefragt. Folge den Hinweisen deines Browsers.",
      installFailed: "Der Installationsdialog konnte nicht geöffnet werden.",
      installOpenShare: "Teilen öffnen",
      installOpenShareDetail: "Tippe in Safari auf Teilen. Der Eintrag kann im Mehr-Menü liegen.",
      installHomeScreen: "Zum Home-Bildschirm",
      installHomeScreenDetail: "Scrolle durch die Aktionen und wähle „Zum Home-Bildschirm“.",
      installConfirmAdd: "Hinzufügen bestätigen",
      installConfirmAddDetail: "Lass „Als Web-App öffnen“ aktiviert, falls angezeigt, und tippe auf „Hinzufügen“.",
      installOpenShareBrowserDetail: "Tippe in Chrome in der Adressleiste auf Teilen. Öffne in Firefox oder Edge das Menü und dann Teilen.",
      installSafariFallback:
        "Kein „Zum Home-Bildschirm“? Dann ist die Seite vielleicht in einer anderen App geöffnet. Öffne sie in Safari.",
      installSafariMenu: "Safari-Menü öffnen",
      installSafariMenuDetail: "Öffne auf deinem Mac in Safari „Ablage“ oder klicke auf Teilen.",
      installAddDock: "Zum Dock hinzufügen",
      installAddDockDetail: "Wähle „Zum Dock hinzufügen“ und bestätige mit „Hinzufügen“. Verfügbar in Safari ab macOS Sonoma.",
      installBrowserMenu: "Browser-Menü öffnen",
      installBrowserMenuDetail: "Nutze das Menü neben der Adressleiste.",
      installAndroidDetail: "Wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“ und folge den Hinweisen des Browsers.",
      installBrowserDetail: "Suche nach „App installieren“ im Menü oder nach einem Installationssymbol in der Adressleiste.",
      installUnavailable:
        "Keine Installationsoption? Nutze die App weiter im Browser oder versuche einen anderen Browser mit Installationsunterstützung.",
      installAppleInAppTitle: "Öffne diese Seite in Safari",
      installAppleInAppDetail: ({ appName }) =>
        `Diese Seite ist in einer anderen App geöffnet, die ${appName} nicht installieren kann. Wähle im Menü dieser App (••• oder Teilen) „In Safari öffnen“ oder kopiere den Link und füge ihn in Safari ein.`,
      installInAppTitle: "Öffne diese Seite in deinem Browser",
      installInAppDetail: ({ appName }) =>
        `Diese Seite ist in einer anderen App geöffnet, die ${appName} nicht installieren kann. Wähle im Menü dieser App „In Chrome öffnen“ oder „Im Browser öffnen“ oder kopiere den Link und füge ihn in Chrome ein.`,
      installAppleBrowserTitle: "Am besten mit Safari",
      installAppleBrowserDetail:
        "In diesem Browser installierst du über Teilen → Zum Home-Bildschirm. Fehlt der Eintrag, öffne diese Seite in Safari.",
      installAndroidBrowserTitle: "Am besten mit Chrome",
      installAndroidBrowserDetail:
        "Suche in diesem Browser im Menü nach „Installieren“ oder „Zum Startbildschirm hinzufügen“. Fehlt der Eintrag, öffne diese Seite in Chrome.",
      installSamsungTitle: "Mit Chrome installieren",
      installSamsungDetail: ({ appName }) =>
        `Auf Samsung-Handys erstellt Samsung Internet ein eigenes App-Paket, das Android ab Version 14 als „für eine ältere Android-Version entwickelt“ blockieren kann. Diese Warnung betrifft das Paket, nicht ${appName}. Mit Chrome installierst du ${appName} ohne sie. Ohne Chrome nutze das Menü dieses Browsers und fahre trotz dieser Warnung fort.`,
      installOpenChrome: "In Chrome öffnen",
      installCopyLink: "Link kopieren",
      installLinkCopied: "Link kopiert",
      installCopyFailed: "Der Link konnte nicht kopiert werden. Kopiere diese Adresse manuell:",
    },
  },
});

export type InstallMessages = ReturnType<(typeof installMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useInstallMessages = (): (() => InstallMessages) => {
  const locale = useLocale();
  return () => installMessages.resolve([locale()]).t;
};

export const checkInstallMessages = () => installMessages.check();
