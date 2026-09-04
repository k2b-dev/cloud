import { isPresentationMode, type PresentationMode } from "./presentation-mode";

/** Preserve navigator filters while selecting one reloadable presentation mode. */
export const withPresentationMode = (href: string, mode: PresentationMode): string => {
  const url = new URL(href, "https://notebooks.invalid");
  url.searchParams.set("mode", mode);
  return `${url.pathname}${url.search}${url.hash}`;
};

export const requestedPresentationMode = (params: URLSearchParams): PresentationMode | undefined => {
  const mode = params.get("mode");
  return isPresentationMode(mode) ? mode : undefined;
};

/** Keep an explicit reading/editing choice when following a plain same-notebook link. */
export const inheritPresentationMode = (href: string, currentHref: string): string => {
  let current: URL;
  let target: URL;
  try {
    current = new URL(currentHref);
    target = new URL(href, current);
  } catch {
    return href;
  }
  const notebook = current.pathname.match(/^\/app\/notebooks\/([^/]+)(?:\/|$)/)?.[1];
  const mode = requestedPresentationMode(current.searchParams);
  if (
    !mode ||
    !notebook ||
    target.origin !== current.origin ||
    target.searchParams.has("mode") ||
    !target.pathname.startsWith(`/app/notebooks/${notebook}/`)
  )
    return href;
  return withPresentationMode(`${target.pathname}${target.search}${target.hash}`, mode);
};
