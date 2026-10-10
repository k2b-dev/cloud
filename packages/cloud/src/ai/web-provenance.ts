import { domainToUnicode } from "node:url";
import { sql } from "bun";
import { toPgTextArray } from "../services/postgres";

/** The longest address web_extract and fetch_file accept; a longer one can never be read, so it is never recorded. */
const WEB_ADDRESS_MAX_CHARS = 2_000;

const URL_TOKEN = /https?:\/\/[^\s<>"'`\\^{}|[\]]+/gi;
/**
 * An address typed without its scheme, such as `example.org/news`. It must start the word: a host inside another
 * address, an email address, or a longer host name is not a typed address of its own.
 */
const BARE_TOKEN =
  /(?<![\w@.\-/:%+~#=?&])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9](?::\d{1,5})?(?:\/[^\s<>"'`\\^{}|[\]]*)?/gi;

/** Drops punctuation that ends the sentence around an address, and a closing bracket the address did not open. */
const trimToken = (token: string): string => {
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    if (".,;:!?*'\"".includes(last)) end--;
    else if (last === ")" && token.slice(0, end).split("(").length <= token.slice(0, end).split(")").length - 1) end--;
    else break;
  }
  return token.slice(0, end);
};

/** The forms of one address that count as the same read: as written, without its fragment, and over HTTPS. */
const addressForms = (raw: string, add: (address: string) => void) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;
  const forms = [url.href];
  if (url.hash) forms.push(url.href.slice(0, -url.hash.length));
  // Upgrading to HTTPS carries no data the address did not already carry.
  if (url.protocol === "http:") forms.push(...forms.map((form) => `https:${form.slice("http:".length)}`));
  for (const form of forms) if (form.length <= WEB_ADDRESS_MAX_CHARS) add(form);
};

/**
 * Every whole address in a text, normalized like a URL the tools read. Only complete tokens count, never a part of a
 * longer address; with `typed`, an address written without its scheme counts too, as a person often types it.
 */
export const webAddressesIn = (text: string, options: { typed?: boolean } = {}): Set<string> => {
  const addresses = new Set<string>();
  const add = (address: string) => addresses.add(address);
  const rest = text.replace(URL_TOKEN, (token) => {
    addressForms(trimToken(token), add);
    return " ";
  });
  if (options.typed)
    for (const [token] of rest.matchAll(BARE_TOKEN)) {
      const bare = trimToken(token);
      addressForms(`https://${bare}`, add);
      addressForms(`http://${bare}`, add);
    }
  return addresses;
};

/** Records addresses a web search returned or a page read in this chat links to; later reads of them do not ask. */
export const recordWebAddresses = async (conversationId: string, addresses: Iterable<string>): Promise<void> => {
  const list = [...addresses];
  if (!list.length) return;
  await sql`
    INSERT INTO ai.web_addresses (conversation_id, address)
    SELECT ${conversationId}::uuid, address FROM unnest(${toPgTextArray(list)}::text[]) address
    ON CONFLICT DO NOTHING
  `;
};

/**
 * Whether the chat itself supplied this address: the person wrote it, a web search returned it, or a page read
 * earlier links to it. A message another chat sent counts as neither. Anything else, such as an address the model
 * assembled from other data, has no provenance. `url` is the normalized address the tool reads.
 */
export const hasWebAddressProvenance = async (conversationId: string, url: string): Promise<boolean> => {
  const [recorded] = await sql<{ found: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM ai.web_addresses WHERE conversation_id = ${conversationId}::uuid AND address = ${url}) AS found
  `;
  if (recorded?.found) return true;
  // Only the person's own messages that name the host are read, never tool results.
  const { hostname } = new URL(url);
  const hosts = [...new Set([hostname, domainToUnicode(hostname) || hostname])];
  const rows = await sql<{ text: string }[]>`
    SELECT text FROM (
      SELECT message, meta FROM ai.messages WHERE conversation_id = ${conversationId}::uuid AND kind = 'message' AND role = 'user'
      UNION ALL
      SELECT message, meta FROM ai.task_messages WHERE conversation_id = ${conversationId}::uuid AND kind = 'message' AND role = 'user'
    ) entry
    CROSS JOIN LATERAL (
      SELECT string_agg(CASE WHEN jsonb_typeof(part) = 'string' THEN part #>> '{}' ELSE part->>'text' END, chr(10)) AS text
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(entry.message->'content') = 'array' THEN entry.message->'content' ELSE '[]'::jsonb END) part
      WHERE jsonb_typeof(part) = 'string' OR part->>'type' = 'text'
    ) content
    WHERE NOT COALESCE(entry.meta ? 'agentMessage', false)
      AND EXISTS (SELECT 1 FROM unnest(${toPgTextArray(hosts)}::text[]) host WHERE strpos(lower(content.text), host) > 0)
  `;
  return rows.some((row) => webAddressesIn(row.text, { typed: true }).has(url));
};
