import type { FibelPlugin } from "@k2b/fibel";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Folds sidebar sections by their label, such as "v1 (existing)": Fibel draws every section open, so this plugin
 * closes the named ones on the server unless the open page is one of theirs. Search, MCP and the pages themselves stay.
 */
export function foldedNavPlugin(labels: readonly string[]): FibelPlugin {
  const patterns = labels.map(
    (label) => new RegExp(`<details class="group" open>(\\s*<summary[^>]*>\\s*${escapeRegExp(label)}\\s*<span[\\s\\S]*?</details>)`, "g"),
  );
  const fold = (html: string) =>
    patterns.reduce(
      (result, pattern) =>
        result.replace(pattern, (section, rest: string) => (rest.includes("is-active") ? section : `<details class="group">${rest}`)),
      html,
    );
  return {
    name: "folded-nav",
    setup(context) {
      const render = context.services.renderPage;
      context.services.renderPage = async (page, request, fibel) => {
        const rendered = await render(page, request, fibel);
        if (typeof rendered === "string") return fold(rendered);
        if (!rendered.headers.get("Content-Type")?.startsWith("text/html")) return rendered;
        return new Response(fold(await rendered.text()), { status: rendered.status, headers: rendered.headers });
      };
    },
  };
}
