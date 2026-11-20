import { respond } from "@k2b/cloud/server";
import { toBase64 } from "@k2b/cloud/shared-text";
import { ok } from "@k2b/stdlib";
import type { Context } from "hono";
import { readDraftDocument } from "../service/draft-documents";
import { type MailApiContext, respondPublic } from "./public-resource-boundary";

/** Shared-document GET boundary: localize failures and serialize Yjs bytes. */
export const respondDraftDocumentRead = async (c: Context<MailApiContext>, params: Parameters<typeof readDraftDocument>[0]) => {
  const result = await readDraftDocument(params);
  if (!result.ok) return respondPublic(c, result);
  const value = result.data;
  return respond(
    c,
    ok({
      generation: value.generation,
      revision: value.revision,
      lifecycle: value.lifecycle,
      historyComplete: value.historyComplete,
      fresh: { ...value.fresh, state: toBase64(value.fresh.state) },
      durable: { ...value.durable, state: toBase64(value.durable.state) },
      frozen: value.frozen ? { ...value.frozen, state: toBase64(value.frozen.state) } : null,
    }),
  );
};
