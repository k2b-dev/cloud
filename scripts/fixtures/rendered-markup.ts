/** Inspect server-rendered markup with Bun's HTML parser, preserving the original serialization. */
export function withoutComments(markup: string): string {
  return new HTMLRewriter()
    .onDocument({
      comments: (comment) => {
        comment.remove();
      },
    })
    .transform(markup);
}

/** Text assertions may separate elements as the former tag-to-space comparisons did. */
export function renderedText(markup: string, separator = ""): string {
  const parts: string[] = [];
  new HTMLRewriter()
    .on("*", {
      element(element) {
        parts.push(separator);
        if (element.canHaveContent)
          element.onEndTag(() => {
            parts.push(separator);
          });
      },
    })
    .onDocument({
      text: (chunk) => {
        parts.push(chunk.text);
      },
    })
    .transform(markup);
  return parts.join("");
}
