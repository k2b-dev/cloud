import {
  CAPABILITY_MAX_RESULT_BYTES,
  CAPABILITY_MAX_REVIEW_BYTES,
  CAPABILITY_MAX_REVIEW_CONTENT_BYTES,
} from "../contracts/capability-limits";
import { codeOwnPath } from "../contracts/code-routes";
import { blockDataAtPath } from "./bind";
import { assertBlockData, assertNoDroppedBlockKeys } from "./data";
import { BLOCK_LIMITS, type Block, BlockPathSchema, BlockSchema } from "./schema";

export type BlockHost = "page" | "result" | "review" | "preview";
export type BlockContext = {
  appId: string;
  appPrefixes: readonly string[];
  codeId?: string;
  /** Complete result or review when checking its envelope budget. */
  envelope?: unknown;
};

/** Decode one segment once; never let URL normalization conceal a different route. */
export function blockPathname(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) throw new Error("blocks_foreign_path");
  const pathname = path.split(/[?#]/, 1)[0]!;
  const segments = pathname.split("/").map((segment) => {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || /[\\/%\u0000-\u0020\u007f]/.test(decoded)) throw new Error("blocks_foreign_path");
    return decoded;
  });
  if (segments.slice(1, -1).some((segment) => !segment)) throw new Error("blocks_foreign_path");
  return segments.join("/");
}
const inApp = (path: string, ctx: BlockContext): boolean =>
  ctx.appPrefixes.some((prefix) => {
    const base = blockPathname(prefix).replace(/\/$/, "");
    return base !== "" && (path === base || path.startsWith(`${base}/`));
  });
export function validateBlockLink(href: string, host: BlockHost, ctx: BlockContext): void {
  if (host === "page") {
    codeOwnPath(ctx.codeId ?? ctx.appId, href);
    return;
  }
  if (host === "result" && href.startsWith("https://")) {
    if (/[\\\u0000-\u0020\u007f]/.test(href)) throw new Error("blocks_foreign_path");
    const url = new URL(href);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("blocks_foreign_path");
    // Inspect the original path before URL removes dot segments.
    const pathname = /^https:\/\/[^/?#]*(\/[^?#]*)?/.exec(href)?.[1] ?? "/";
    blockPathname(pathname);
    return;
  }
  const pathname = blockPathname(href);
  if (host !== "result") return;
  if (!inApp(pathname, ctx) && !/^\/open\/[a-z][a-z0-9-]*\.[a-z][a-z0-9._-]*\/~[^/]+$/.test(pathname))
    throw new Error("blocks_foreign_path");
}
export function validateBlockImage(src: string, ctx: BlockContext): void {
  const pathname = blockPathname(src);
  // Images use the responding app's authorized same-origin routes. /open/<type>/~<id> is
  // a resource navigation redirect, not file bytes; Files v2 currently issues download leases.
  // Do not invent /api/files/<id> or turn a resource ref into an unauthenticated image URL.
  if (!inApp(pathname, ctx)) throw new Error("blocks_foreign_image");
}
const uniqueFields = (fields: { name: string }[]) => {
  if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new Error("blocks_duplicate_field");
};
const mapped = (item: unknown, path: string[], required = false): unknown => {
  BlockPathSchema.parse(path);
  const value = blockDataAtPath(item, path);
  if (required && (typeof value !== "string" || !value.trim())) throw new Error("blocks_mapping");
  return value;
};

/** Pure host validation of an already bound tree. Transport owners separately cap the complete envelope. */
export function validateBlocks(value: unknown, host: BlockHost, ctx: BlockContext): Block[] {
  const maxBytes =
    host === "page" ? BLOCK_LIMITS.bytes : host === "review" ? CAPABILITY_MAX_REVIEW_CONTENT_BYTES : CAPABILITY_MAX_RESULT_BYTES;
  assertBlockData(value, maxBytes);
  if (ctx.envelope !== undefined) {
    if (host === "review") {
      // First guard the complete object so metadata extraction cannot invoke a getter.
      assertBlockData(ctx.envelope, CAPABILITY_MAX_REVIEW_CONTENT_BYTES + CAPABILITY_MAX_REVIEW_BYTES + 11);
      if (!ctx.envelope || typeof ctx.envelope !== "object" || Array.isArray(ctx.envelope)) throw new Error("blocks_envelope");
      const metadata = Object.fromEntries(Object.entries(ctx.envelope).filter(([key]) => key !== "view"));
      assertBlockData(metadata, CAPABILITY_MAX_REVIEW_BYTES);
      const view = blockDataAtPath(ctx.envelope, ["view"]);
      if (view !== undefined) assertBlockData(view, maxBytes);
    } else assertBlockData(ctx.envelope, maxBytes);
  }

  if (!Array.isArray(value)) throw new Error("blocks_tree");
  const blocks = value.map((node) => BlockSchema.parse(node));
  assertNoDroppedBlockKeys(value, blocks);
  let nodes = 0,
    choices = 0,
    drafts = 0;
  const ids = new Set<string>();
  const selectors: string[] = [];
  const check = (node: Block, depth: number): void => {
    if (++nodes > BLOCK_LIMITS.nodes || depth > BLOCK_LIMITS.depth) throw new Error("blocks_limit");
    if (node.kind === "Section") node.children.forEach((child) => check(child, depth + 1));
    if (node.kind === "Form" || node.kind === "Button" || node.kind === "Action") {
      if (host !== "page") throw new Error("blocks_host");
      codeOwnPath(ctx.codeId ?? ctx.appId, node.action);
      if (node.kind === "Form") uniqueFields(node.fields);
    }
    if (node.kind === "Link") validateBlockLink(node.href, host, ctx);
    if (node.kind === "Image") validateBlockImage(node.src, ctx);
    if (node.kind === "Chart" && (node.description ? node.title !== undefined : node.title === undefined || node.empty === undefined))
      throw new Error("blocks_chart");
    if (node.kind === "Draft") {
      if (host !== "review" || ++drafts > 1) throw new Error("blocks_host");
      uniqueFields(node.fields);
    }
    if (node.kind === "Choice") {
      if (host !== "result" || ++choices > 1) throw new Error("blocks_host");
      ids.add(node.id);
      const optionIds = new Set<string>();
      for (const option of node.options) {
        const id = mapped(option, node.option.id, true);
        if (typeof id !== "string") throw new Error("blocks_mapping");
        if (optionIds.has(id)) throw new Error("blocks_duplicate_option");
        optionIds.add(id);
        mapped(option, node.option.title, true);
        if (node.option.subtitle) mapped(option, node.option.subtitle, true);
      }
      if (node.then) {
        const prefix = `${ctx.appId}.query.`;
        if (!node.then.query.startsWith(prefix) || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(node.then.query.slice(prefix.length)))
          throw new Error("blocks_then_query");
      }
    }
    if (node.kind === "Table") {
      if (host === "page") {
        if (node.columns.some((column) => column.path !== undefined) || node.rowId || node.rowHref) throw new Error("blocks_host");
        const columns = new Set(node.columns.map((column) => column.key));
        if (
          columns.size !== node.columns.length ||
          node.rows.some((row) => !row || typeof row !== "object" || Object.keys(row).some((key) => !columns.has(key)))
        )
          throw new Error("blocks_table_columns");
      } else if (node.columns.some((column) => !column.path)) throw new Error("blocks_table_columns");
      for (const row of node.rows) {
        for (const column of node.columns) {
          const cell = mapped(row, column.path ?? [column.key!]);
          if (cell !== undefined && cell !== null && !["string", "number", "boolean"].includes(typeof cell))
            throw new Error("blocks_table_cell");
        }
        if (node.rowId) mapped(row, node.rowId, true);
        if (node.rowHref) {
          const href = mapped(row, node.rowHref);
          if (href !== undefined && href !== null) {
            if (typeof href !== "string") throw new Error("blocks_mapping");
            validateBlockLink(href, host, ctx);
          }
        }
      }
    }
    if (node.kind === "Cards") {
      for (const item of node.items) {
        mapped(item, node.card.id, true);
        mapped(item, node.card.title, true);
        for (const key of ["subtitle", "imageAlt", "rating", "price"] as const)
          if (node.card[key]) {
            const value = mapped(item, node.card[key]);
            if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number")
              throw new Error("blocks_mapping");
          }
        if (node.card.badges) {
          const badges = mapped(item, node.card.badges);
          if (
            badges !== undefined &&
            (!Array.isArray(badges) || badges.length > BLOCK_LIMITS.rows || badges.some((badge) => typeof badge !== "string"))
          )
            throw new Error("blocks_mapping");
        }
        for (const fact of node.card.facts ?? []) {
          const value = mapped(item, fact.value);
          if (value !== undefined && value !== null && !["string", "number", "boolean"].includes(typeof value))
            throw new Error("blocks_mapping");
        }
        for (const key of ["image", "href"] as const)
          if (node.card[key]) {
            const target = mapped(item, node.card[key]);
            if (target === undefined || target === null) continue;
            if (typeof target !== "string") throw new Error("blocks_mapping");
            if (key === "image") validateBlockImage(target, ctx);
            else validateBlockLink(target, host, ctx);
          }
      }
      if (node.choose) {
        if (host !== "result") throw new Error("blocks_host");
        selectors.push(node.choose);
      }
    }
  };
  blocks.forEach((node) => check(node, 1));
  if (selectors.some((id) => !ids.has(id))) throw new Error("blocks_choice_target");
  if (drafts) {
    assertBlockData(value, CAPABILITY_MAX_RESULT_BYTES);
    if (ctx.envelope !== undefined) {
      const view = blockDataAtPath(ctx.envelope, ["view"]);
      if (view !== undefined) assertBlockData(view, CAPABILITY_MAX_RESULT_BYTES);
    }
  }
  return blocks;
}
