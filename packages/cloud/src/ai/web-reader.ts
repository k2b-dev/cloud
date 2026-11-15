import { HTTPException } from "hono/http-exception";
import { Lexer, type Token } from "marked";
import { z } from "zod";
import type { RequestActor } from "../server/middleware/auth";
import { type NetworkLookup, NetworkTargetBlockedError, resolvePublicNetworkAddresses } from "../services/network-security";
import { awaitNetworkOperation, withNetworkDeadline } from "../services/network-transport";
import { AI_WEBSITE_APPROVAL_TOOL, aiWebsiteApprovalScope, findRememberedAiToolApproval } from "./approvals";
import {
  assertPublicHttpUrl,
  FIRECRAWL_TOOL_TIMEOUT_MS,
  isCloudAiFirecrawlConfigured,
  runCloudAiWebExtract,
  WEB_EXTRACT_MAX_CONTENT_CHARS,
} from "./firecrawl-tools";
import { hasWebAddressProvenance, recordWebAddresses, webAddressesIn } from "./web-provenance";

export const WebReaderResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    url: z.string(),
    finalUrl: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    markdown: z.string(),
    truncated: z.boolean(),
    contentAt: z.string().datetime(),
  }),
  z.object({ status: z.literal("confirm"), url: z.string() }),
  z.object({ status: z.literal("redirect_blocked"), url: z.string(), finalUrl: z.string() }),
  z.object({ status: z.literal("unreadable"), url: z.string(), reason: z.enum(["empty", "failed"]) }),
  z.object({ status: z.literal("unavailable") }),
]);

export type WebReaderResult = z.infer<typeof WebReaderResultSchema>;

/** Preserve Markdown and normal links; raw HTML is data, never markup for the reader. */
export const stripWebReaderImages = (markdown: string): string => {
  markdown = markdown.replace(/<img\b(?:[^<>"']|"[^"]*"|'[^']*')*>/gi, "");
  const lexer = new Lexer();
  // Collect reference definitions before parsing inline and reference-style images.
  lexer.lex(markdown);
  const clean = (tokens: Token[]): string =>
    tokens
      .map((token) => {
        if (token.type === "image") return "";
        if (token.type === "html") return token.raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if ("tokens" in token && token.tokens) {
          const source = token.tokens.map((child) => child.raw).join("");
          return token.raw.replace(source, () => clean(token.tokens ?? []));
        }
        return token.raw;
      })
      .join("");
  return (
    clean(lexer.inlineTokens(markdown))
      // Removing an image can join surrounding text into new image or HTML syntax.
      .replace(/(\\*)!\[/g, (match, slashes: string) => (slashes.length % 2 ? match : `${slashes}\\![`))
      .replace(/<(?=\/?[a-zA-Z][\w:-]*(?:\s|\/?>))/g, "&lt;")
  );
};

const publicUrl = (raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HTTPException(400, { message: "URL must be valid." });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new HTTPException(400, { message: "URL must use HTTP or HTTPS without credentials." });
  try {
    return assertPublicHttpUrl(raw);
  } catch {
    throw new HTTPException(403, { message: "URL must point to a public network target." });
  }
};

/** The same address, up to the upgrade to HTTPS and a trailing slash, which sites add on their own. */
const sameDestination = (finalUrl: string, url: string) => {
  const normal = (value: string) => {
    const parsed = new URL(value);
    parsed.protocol = "https:";
    parsed.hash = "";
    if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
    return parsed.href;
  };
  return normal(finalUrl) === normal(url);
};

/** The caller resolves the owned chat to its internal UUID before invoking this user-backed read. */
export const readWebPageForPerson = async (
  input: { actor: RequestActor; conversationId: string; url: string; confirmed?: boolean; signal?: AbortSignal },
  options: { lookup?: NetworkLookup } = {},
): Promise<WebReaderResult> => {
  const user = input.actor.kind === "user" ? input.actor.user : input.actor.delegatedUser;
  if (!user) throw new HTTPException(403, { message: "Web reading requires a user-backed actor." });
  const url = publicUrl(input.url);
  if (!(await isCloudAiFirecrawlConfigured())) return { status: "unavailable" };

  const allowed = async (address: string) =>
    (await hasWebAddressProvenance(input.conversationId, address)) ||
    (await findRememberedAiToolApproval(
      { actorUserId: user.id },
      {
        toolName: AI_WEBSITE_APPROVAL_TOOL,
        approvalScope: aiWebsiteApprovalScope(new URL(address).origin),
        conversationId: input.conversationId,
        chatOnly: true,
      },
    )) !== null;
  if (!input.confirmed && !(await allowed(url))) return { status: "confirm", url };

  try {
    return await withNetworkDeadline(FIRECRAWL_TOOL_TIMEOUT_MS, input.signal, new Error("Web reading timed out."), async (signal) => {
      const check = async (address: string) => {
        await awaitNetworkOperation(resolvePublicNetworkAddresses(new URL(address).hostname, options.lookup), signal);
      };
      await check(url);
      // A fresh scrape makes this the content's time, rather than the click time of a cached page.
      const contentAt = new Date().toISOString();
      // The fetch runs only through the hosted service; Cloud does not fetch other addresses itself. A self-hosted
      // fetch service or a direct fetch from Cloud first needs an IP check of the resolved address, pinning that address
      // for the connection, and the same check for every redirect.
      const output = await runCloudAiWebExtract({ url }, { maxAge: 0, signal });
      const finalUrl = publicUrl(output.url);
      await check(finalUrl);
      // A confirmation covers exactly the confirmed address, not its site: any other destination needs its own right.
      if (sameDestination(finalUrl, url) ? false : !(await allowed(finalUrl))) return { status: "redirect_blocked", url, finalUrl };
      signal.throwIfAborted();
      const cleaned = stripWebReaderImages(output.content).trim();
      const markdown = cleaned.slice(0, WEB_EXTRACT_MAX_CONTENT_CHARS);
      if (!markdown || !Lexer.lex(markdown).some((token) => token.type !== "space" && token.type !== "def"))
        return { status: "unreadable", url, reason: "empty" };
      // Only an explicit, otherwise empty interstitial counts. Do not infer readability from article keywords.
      if (/^(?:please )?(?:enable javascript(?: to continue)?|sign in to continue|log in to continue)[.!]?$/i.test(markdown))
        return { status: "unreadable", url, reason: "failed" };
      await recordWebAddresses(
        input.conversationId,
        new Set([...webAddressesIn(url), ...webAddressesIn(finalUrl), ...webAddressesIn(output.content)]),
      );
      return {
        status: "ready",
        url,
        finalUrl,
        title: output.title ?? new URL(finalUrl).hostname,
        description: output.description ?? null,
        markdown,
        truncated: output.truncated || cleaned.length > WEB_EXTRACT_MAX_CONTENT_CHARS,
        contentAt,
      };
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof NetworkTargetBlockedError) throw new HTTPException(403, { message: "URL must point to a public network target." });
    input.signal?.throwIfAborted();
    return { status: "unreadable", url, reason: "failed" };
  }
};
