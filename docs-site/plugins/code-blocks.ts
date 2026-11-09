import type { FibelPlugin } from "@k2b/fibel";

/**
 * Renders two fenced block kinds as page mockups:
 *
 * - ```tree <caption>: one entry per line, two spaces per level, folders end
 *   with "/", and an optional "# note" after the name.
 * - ```terminal <caption>: lines starting with "$ " are commands, lines
 *   starting with "# " are notes, every other line is output. Copy takes the
 *   commands only.
 *
 * Raw Markdown, search, MCP and llms.txt keep the plain fenced text.
 */
export function codeBlocksPlugin(): FibelPlugin {
  return {
    name: "code-blocks",
    setup(context) {
      const render = context.services.renderMarkdown;
      context.services.renderMarkdown = (markdown, page, fibel) => render(renderMockups(markdown), page, fibel);
    },
  };
}

const fence = /^```(tree|terminal)(?:[ \t]+([^\n]*))?\n([\s\S]*?)\n```[ \t]*$/gm;

export function renderMockups(markdown: string) {
  return markdown.replace(fence, (_match, kind: string, caption: string | undefined, body: string) =>
    kind === "tree" ? renderTree(body, caption?.trim()) : renderTerminal(body, caption?.trim()),
  );
}

type TreeNode = { name: string; note: string; folder: boolean; children: TreeNode[] };

function parseTree(body: string) {
  const root: TreeNode[] = [];
  const stack: { depth: number; children: TreeNode[] }[] = [{ depth: -1, children: root }];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const depth = Math.floor((line.length - line.trimStart().length) / 2);
    const [rawName = "", ...noteParts] = line.trim().split(/\s+#\s?/);
    const name = rawName.trim();
    const node: TreeNode = { name, note: noteParts.join(" # ").trim(), folder: name.endsWith("/"), children: [] };
    while (stack.length > 1 && (stack.at(-1)?.depth ?? -1) >= depth) stack.pop();
    stack.at(-1)?.children.push(node);
    stack.push({ depth, children: node.children });
  }
  return root;
}

function renderTreeNodes(nodes: TreeNode[]): string {
  return nodes
    .map((node) => {
      const icon = node.folder ? folderIcon : fileIcon;
      const note = node.note ? `<span class="code-tree-note">${escape(node.note)}</span>` : "";
      const children = node.children.length ? `<ul>${renderTreeNodes(node.children)}</ul>` : "";
      const kind = node.folder ? "folder" : "file";
      return `<li data-kind="${kind}"><span class="code-tree-row">${icon}<span class="code-tree-name">${escape(node.name)}</span>${note}</span>${children}</li>`;
    })
    .join("");
}

function renderTree(body: string, caption?: string) {
  const label = caption || "Project files";
  const head = caption ? `<figcaption class="code-mock-head"><span>${escape(caption)}</span></figcaption>` : "";
  return `<figure class="code-mock code-tree">${head}<ul aria-label="${escape(label)}">${renderTreeNodes(parseTree(body))}</ul></figure>`;
}

function renderTerminal(body: string, caption?: string) {
  const lines = body.split("\n");
  const commands = lines.filter((line) => line.startsWith("$ ")).map((line) => line.slice(2));
  const rendered = lines
    .map((line) => {
      if (line.startsWith("$ ")) {
        return `<span class="code-term-line" data-kind="command"><span class="code-term-prompt" aria-hidden="true">$</span> ${escape(line.slice(2))}</span>`;
      }
      if (line.startsWith("# ")) return `<span class="code-term-line" data-kind="note">${escape(line)}</span>`;
      return `<span class="code-term-line" data-kind="output">${escape(line) || " "}</span>`;
    })
    .join("");
  const copy = commands.length
    ? `<button class="code-copy" type="button" data-copy-code="${Buffer.from(commands.join("\n"), "utf8").toString("base64")}" aria-label="Copy commands">${copyIcon}</button>`
    : "";
  return `<figure class="code-mock code-term"><figcaption class="code-mock-head"><span class="code-term-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${escape(caption || "Terminal")}</span>${copy}</figcaption><pre><code>${rendered}</code></pre></figure>`;
}

function escape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const folderIcon =
  '<svg class="code-tree-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"/></svg>';
const fileIcon =
  '<svg class="code-tree-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2"/></svg>';
const copyIcon =
  '<span class="code-copy-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></span>';
