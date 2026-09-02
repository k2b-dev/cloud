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
