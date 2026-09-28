/** Attributes and text of every element that matches a CSS selector in rendered markup. */
export const selectHtml = async (html: string, selector: string) => {
  const found: { attributes: Record<string, string>; text: string }[] = [];
  await new HTMLRewriter()
    .on(selector, {
      element(element) {
        found.push({ attributes: Object.fromEntries(element.attributes), text: "" });
      },
      text(chunk) {
        const match = found.at(-1);
        if (match) match.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();
  return found;
};
