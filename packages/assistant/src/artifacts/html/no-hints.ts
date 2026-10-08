// Imported by the prelude before any app code runs: keeps <link> elements out of the app document.
//
// WebKit (Safari and every iOS browser) acts on <link rel="preconnect"> the moment the element
// enters the document: DNS, TCP and TLS to a host the app names, and no CSP directive applies.
// Removing such an element afterwards is too late, so every DOM method that inserts nodes or
// parses markup drops link elements before they reach the document, and the patched entry points
// are frozen. A mutation observer removes links that arrive any other way, after the fact.
// This narrows the gap; it is no boundary. Code that reaches an entry point not covered here wins
// the race, and only a separate app origin closes it.
import { CloudError } from "../runtime/errors";

type Method = (this: unknown, ...args: unknown[]) => unknown;

let warned = false;
const dropped = () => {
  if (warned) return;
  warned = true;
  console.warn("Cloud removed a <link> element: Studio apps load nothing from the network. Put CSS into style.css.");
};
const isLink = (node: unknown): node is Element => node instanceof Element && node.localName === "link";
/** False for a link element; removes link elements inside an element or fragment. */
function keep(node: unknown) {
  if (isLink(node)) {
    dropped();
    return false;
  }
  if (node instanceof Element || node instanceof DocumentFragment)
    for (const link of node.querySelectorAll("link")) {
      link.remove();
      dropped();
    }
  return true;
}

/** Replaces a prototype member for good: app code can neither restore nor redefine it. */
function freeze(proto: object, name: string, patch: (native: PropertyDescriptor) => PropertyDescriptor) {
  const native = Object.getOwnPropertyDescriptor(proto, name);
  if (!native) return;
  Object.defineProperty(proto, name, { ...patch(native), enumerable: native.enumerable, configurable: false });
}
const method = (proto: object, name: string, wrap: (native: Method) => Method) =>
  freeze(proto, name, (native) => ({ value: wrap(native.value as Method), writable: false }));
const setter = (proto: object, name: string, wrap: (native: Method) => Method) =>
  freeze(proto, name, (native) => ({ get: native.get, set: wrap(native.set as Method) }));

// Node insertion.
for (const name of ["appendChild", "insertBefore", "moveBefore"])
  for (const proto of [Node.prototype, Element.prototype, Document.prototype, DocumentFragment.prototype])
    method(
      proto,
      name,
      (native) =>
        function (node, ...rest) {
          return keep(node) ? native.call(this, node, ...rest) : node;
        },
    );
method(
  Node.prototype,
  "replaceChild",
  (native) =>
    function (node, child) {
      return keep(node) ? native.call(this, node, child) : (this as Node).removeChild(child as Node);
    },
);
for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype, CharacterData.prototype, DocumentType.prototype])
  for (const name of ["append", "prepend", "replaceChildren", "before", "after", "replaceWith"])
    method(
      proto,
      name,
      (native) =>
        function (...nodes) {
          return native.apply(this, nodes.filter(keep));
        },
    );
method(
  Element.prototype,
  "insertAdjacentElement",
  (native) =>
    function (where, node) {
      return keep(node) ? native.call(this, where, node) : null;
    },
);
for (const name of ["insertNode", "surroundContents"])
  method(
    Range.prototype,
    name,
    (native) =>
      function (node) {
        if (keep(node)) native.call(this, node);
      },
  );
setter(
  Document.prototype,
  "body",
  (native) =>
    function (body) {
      keep(body);
      native.call(this, body);
    },
);

// Markup. A link element only comes from the characters "<link" (tag names know no entities), so
// markup without them goes straight to the parser. Other markup is parsed in a document without a
// browsing context, where a hint does nothing, and inserted without its links.
const hasLink = (markup: string) => /<link/i.test(markup);
const inert = document.implementation.createHTMLDocument("");
const nativeInnerHtml = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!.set!;
/** The nodes `context.innerHTML = markup` would create, without link elements. */
function parse(context: Element | null, markup: string) {
  const shell = inert.createElementNS(context?.namespaceURI ?? "http://www.w3.org/1999/xhtml", context?.localName ?? "body");
  nativeInnerHtml.call(shell, markup);
  for (const link of shell.querySelectorAll("link")) {
    link.remove();
    dropped();
  }
  return [...shell.childNodes];
}
const contextOf = (parent: ParentNode | null) => (parent instanceof Element ? parent : null);
const fits = (parent: ParentNode | null) => parent instanceof Element || parent instanceof DocumentFragment;

for (const proto of [Element.prototype, ShadowRoot.prototype])
  setter(
    proto,
    "innerHTML",
    (native) =>
      function (value) {
        const markup = value === null ? "" : String(value);
        // Template content never enters the document; inserting it later goes through the methods above.
        if (!hasLink(markup) || this instanceof HTMLTemplateElement) return native.call(this, markup);
        (this as ParentNode).replaceChildren(...parse(this instanceof Element ? this : null, markup));
      },
  );
setter(
  Element.prototype,
  "outerHTML",
  (native) =>
    function (value) {
      const markup = value === null ? "" : String(value);
      const parent = (this as Element).parentNode;
      if (!hasLink(markup) || !fits(parent)) return native.call(this, markup);
      (this as Element).replaceWith(...parse(contextOf(parent), markup));
    },
);
method(
  Element.prototype,
  "insertAdjacentHTML",
  (native) =>
    function (position, value) {
      const markup = String(value);
      const where = String(position).toLowerCase();
      const element = this as Element;
      const outside = where === "beforebegin" || where === "afterend";
      // Unknown positions and missing parents keep the native errors.
      if (
        !hasLink(markup) ||
        !["beforebegin", "afterbegin", "beforeend", "afterend"].includes(where) ||
        (outside && !fits(element.parentNode))
      )
        return native.call(this, position, markup);
      const nodes = parse(outside ? contextOf(element.parentNode) : element, markup);
      if (where === "beforebegin") element.before(...nodes);
      else if (where === "afterbegin") element.prepend(...nodes);
      else if (where === "beforeend") element.append(...nodes);
      else element.after(...nodes);
    },
);
// Sanitizer and declarative shadow DOM parsing: a shadow root could hide a link from the filter,
// and falling back to innerHTML would drop sanitizing, so markup with a link is refused.
const refuseLinks = (native: Method): Method =>
  function (value, ...rest) {
    const markup = String(value);
    if (hasLink(markup))
      throw new CloudError("unavailable", "<link> elements do not work in Studio apps: they load nothing; put CSS into style.css");
    return native.call(this, markup, ...rest);
  };
for (const proto of [Element.prototype, ShadowRoot.prototype])
  for (const name of ["setHTML", "setHTMLUnsafe"]) method(proto, name, refuseLinks);
for (const name of ["parseHTML", "parseHTMLUnsafe"]) method(Document, name, refuseLinks);
method(
  Document.prototype,
  "execCommand",
  (native) =>
    function (command, ...rest) {
      if (String(command).toLowerCase() === "inserthtml" && hasLink(String(rest[1]))) {
        dropped();
        return false;
      }
      return native.call(this, command, ...rest);
    },
);
// After load, document.write replaces the whole document through the parser, out of reach of the filter.
for (const name of ["open", "write", "writeln"])
  method(Document.prototype, name, () => () => {
    throw new CloudError("unavailable", `document.${name}() does not work in Studio apps: build the page with DOM methods or innerHTML`);
  });

// Everything else: links that still arrive are removed once the document tells.
const sweep = new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.type === "attributes" ? [record.target] : record.addedNodes) if (!keep(node)) (node as Element).remove();
});
const watch = (root: Node) => sweep.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["rel", "href"] });
watch(document);
method(
  Element.prototype,
  "attachShadow",
  (native) =>
    function (...args) {
      const root = native.apply(this, args) as ShadowRoot;
      watch(root);
      return root;
    },
);
