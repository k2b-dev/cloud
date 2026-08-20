export const appFaviconHref = (appId: string, version: number): string =>
  appId === "core" ? "/branding/favicon" : `/public/${appId}/favicon.svg?v=${version}`;
