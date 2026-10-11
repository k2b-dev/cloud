/** Rewrite Cloud-relative Markdown links while retaining incomplete delimiters between deltas. */
export const createCloudLinkRewriter = (base: string): { push(text: string): string; flush(): string } => {
  const server = base.replace(/\/+$/, "");
  let pending = "";
  return {
    push(text) {
      const input = pending + text;
      pending = ["](/", "](", "]"].find((tail) => input.endsWith(tail)) ?? "";
      return input.slice(0, input.length - pending.length).replace(/\]\(\/(?!\/)/g, () => `](${server}/`);
    },
    flush() {
      const text = pending;
      pending = "";
      return text;
    },
  };
};
