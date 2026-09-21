/**
 * The route of the current request as `pathname + search`.
 *
 * Behind the gateway `c.req.raw.url` carries the internal upstream origin
 * (`http://app-mail:3000`), never the public one. Islands and links must
 * therefore receive the route as a path and resolve it against
 * `window.location.origin` in the browser.
 */
export const requestPath = (c: { req: { raw: { url: string } } }): string => {
  const url = new URL(c.req.raw.url);
  return `${url.pathname}${url.search}`;
};
