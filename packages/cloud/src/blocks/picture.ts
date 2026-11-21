/** The source of a later try: the same route, which checks the reader again, under an address no cache has answered. */
export const retrySource = (src: string, attempt: number): string => {
  if (!attempt) return src;
  const hash = src.indexOf("#");
  const [path, fragment] = hash < 0 ? [src, ""] : [src.slice(0, hash), src.slice(hash)];
  return `${path}${path.includes("?") ? "&" : "?"}retry=${attempt}${fragment}`;
};

/**
 * Whether a server-drawn picture failed before hydration attached its error listener. Only a picture the browser has
 * already asked for counts: a lazy one outside the viewport has not been asked yet and reports its own error later. A
 * picture that decodes is drawn, even with no natural width, as an SVG with only a `viewBox` reports in some browsers.
 */
export const failedBeforeHydration = async (image: HTMLImageElement): Promise<boolean> => {
  if (!image.complete || image.naturalWidth > 0) return false;
  if (image.loading === "lazy") {
    const box = image.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) return false;
  }
  return image.decode().then(
    () => false,
    () => true,
  );
};
