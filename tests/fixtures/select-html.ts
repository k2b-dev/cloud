/** Attributes and text content of every element that matches a CSS selector in rendered markup. */
export const selectHtml = async (html: string, selector: string) => {
  const found: { attributes: Record<string, string>; text: string }[] = [];
  // Matches whose end tag has not been reached; a chunk belongs to each of them, as in `textContent`.
  const open = new Set<(typeof found)[number]>();
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        const match = { attributes: Object.fromEntries(element.attributes), text: "" };
        found.push(match);
        if (!element.canHaveContent) return;
        open.add(match);
        element.onEndTag(() => void open.delete(match));
      },
      text(chunk) {
        for (const match of open) match.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found;
};
