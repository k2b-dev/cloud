/**
 * Runs in the page (`page.evaluate(sentVsLive)`): where the live page under `#root` differs from what the server sent,
 * which the test kept as `window.__k2Sent` (a clone of `#root` before the client ran), in elements, texts and
 * attributes. The one comparison of every hydration test, so each counts the same:
 * - the keys of hydration (`data-hk`) and comments do not count;
 * - a style counts by its declarations, not their spelling;
 * - a place the live page measures after hydration does not count: a grip in the middle of the part of its line in
 *   sight (`--k2-grip-top`, layout.tsx). Add a property here only for such a measured place, never for a mismatch.
 *
 * Self-contained, as Playwright sends its source into the page.
 */
export const sentVsLive = (): string[] => {
  const measured = new Set(["--k2-grip-top"]);
  const sent = Reflect.get(window, "__k2Sent");
  const live = document.getElementById("root");
  if (!(sent instanceof Node) || !live) return ["the page holds no sent copy (window.__k2Sent) or no #root"];
  const found: string[] = [];
  const style = (element: Element) => {
    const probe = document.createElement("i");
    probe.setAttribute("style", element.getAttribute("style") ?? "");
    return Array.from(probe.style)
      .filter((name) => !measured.has(name))
      .map((name) => `${name}:${probe.style.getPropertyValue(name)}`)
      .sort()
      .join(";");
  };
  const nodes = (parent: Node) =>
    Array.from(parent.childNodes).filter((node) => node.nodeType === 1 || (node.nodeType === 3 && node.textContent !== ""));
  const walk = (a: Node, b: Node, path: string) => {
    if (a.nodeType === 3 || b.nodeType === 3) {
      if (a.nodeType !== b.nodeType || a.textContent !== b.textContent)
        found.push(`${path}: text "${a.textContent}" became "${b.textContent}"`);
      return;
    }
    if (!(a instanceof Element) || !(b instanceof Element)) return;
    if (a.tagName !== b.tagName) {
      found.push(`${path}: <${a.tagName}> became <${b.tagName}>`);
      return;
    }
    const names = new Set([...a.getAttributeNames(), ...b.getAttributeNames()].filter((name) => name !== "data-hk"));
    for (const name of names) {
      const same = name === "style" ? style(a) === style(b) : a.getAttribute(name) === b.getAttribute(name);
      if (!same) found.push(`${path} ${a.tagName.toLowerCase()}[${name}]: "${a.getAttribute(name)}" became "${b.getAttribute(name)}"`);
    }
    const [left, right] = [nodes(a), nodes(b)];
    if (left.length !== right.length) found.push(`${path} ${a.tagName.toLowerCase()}: ${left.length} children became ${right.length}`);
    left.forEach((child, index) => {
      const other = right[index];
      if (other) walk(child, other, `${path} > ${index}`);
    });
  };
  walk(sent, live, "root");
  return found;
};
