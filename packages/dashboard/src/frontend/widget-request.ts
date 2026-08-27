import { LOCALE_HEADER } from "@valentinkolb/cloud/shared";

/** Preserve the authenticated browser session and the one resolved request locale across the server-side widget fan-out. */
export const dashboardWidgetRequestHeaders = (cookie: string, locale: string): Headers => {
  const headers = new Headers({ [LOCALE_HEADER]: locale });
  if (cookie) headers.set("Cookie", cookie);
  return headers;
};
