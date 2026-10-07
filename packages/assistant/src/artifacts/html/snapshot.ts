// A static copy of a running app for download or PDF. App content never opens
// as a document on the Cloud origin, and the copy runs nothing when opened.
const STRICT = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'";
const REMOVED = "script, iframe, frame, object, embed, base, meta[http-equiv], animate, set, animateMotion, animateTransform";
const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "data", "poster"];
const SCRIPT_URL = /^\s*(javascript|vbscript|data\s*:\s*text\/html)/i;

export function sanitizeSnapshot(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of doc.querySelectorAll(REMOVED)) element.remove();
  for (const element of doc.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      const value = element.getAttribute(name) ?? "";
      // A copy sends nothing: forms lose their targets as well.
      if (
        /^on/i.test(name) ||
        name === "srcdoc" ||
        name === "action" ||
        name === "formaction" ||
        (URL_ATTRIBUTES.includes(name.toLowerCase()) && SCRIPT_URL.test(value))
      )
        element.removeAttribute(name);
    }
  }
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = STRICT;
  doc.head.prepend(csp);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}
