import type { AppInstallable } from "../contracts/installable";
import { escapeHtml } from "../shared/markdown/shared";

export const installableHead = (app: AppInstallable, resolved: "light" | "dark" | undefined) => {
  const theme = resolved ?? "light";
  return {
    html: "",
    viewport: "width=device-width, initial-scale=1, viewport-fit=cover",
    app: `<meta name="theme-color" data-app-pwa-theme content="${app.themeColor[theme]}">
    <link rel="manifest" data-app-pwa-manifest href="${app.path}manifest.webmanifest?theme=${theme}">
    <link rel="apple-touch-icon" data-app-pwa-apple href="${app.path}apple-touch-icon-${theme}.png">
    <meta name="apple-mobile-web-app-title" content="${escapeHtml(app.shortName)}">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <style data-app-pwa-canvas>html{background:${app.themeColor.light}}html.dark{background:${app.themeColor.dark}}body{box-sizing:border-box;min-height:100dvh;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}[data-app-pwa-runtime]:not(:empty){max-width:40rem;margin:1rem auto}</style>`,
    styles: "<style data-app-pwa-navigation>@view-transition{navigation:none}</style>",
  };
};

/** Runs after the shared theme bootstrap, before first paint or island downloads. All interpolations are validated paths/hex colors. */
export const installableThemeScript = (app: AppInstallable): string =>
  `!function(){var t=document.documentElement.classList.contains('dark')?'dark':'light';document.querySelector('meta[data-app-pwa-theme]').content=${JSON.stringify(app.themeColor)}[t];document.querySelector('link[data-app-pwa-manifest]').href=${JSON.stringify(`${app.path}manifest.webmanifest?theme=`)}+t;document.querySelector('link[data-app-pwa-apple]').href=${JSON.stringify(`${app.path}apple-touch-icon-`)}+t+'.png'}();`;
