export const appFaviconHref = (appId: string, version: string | number | undefined): string =>
  appId === "core"
    ? "/branding/favicon"
    : `/public/${appId}/favicon.svg${version === undefined ? "" : `?v=${encodeURIComponent(version)}`}`;
