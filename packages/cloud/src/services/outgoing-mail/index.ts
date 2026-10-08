import { fail, ok, type Result } from "@k2b/stdlib";
import { getProcessApplicationId, getProcessPlatformPermissions } from "../../_internal/process-identity";
import {
  MailBatchSchema,
  type MailFilter,
  MailFilterSchema,
  type MailMessage,
  MailMessageSchema,
  type MailPage,
  type MailPageParams,
  MailPageParamsSchema,
  type MailProfile,
  type MailRecord,
  type MailServiceError,
} from "../../contracts/outgoing-mail";
import { cancelMailStreams } from "./attachments";
import { enqueueMail } from "./enqueue";
import { outgoingMailMessages, recordMailBatch, recordMailSend } from "./messages";
import { sendMail } from "./send";
import { OutgoingMailError, outgoingMailStore } from "./store";

const identity = (): Result<string, MailServiceError> => {
  const appId = getProcessApplicationId();
  if (!appId) return fail({ code: "mail_unavailable", message: "Start the application before using outgoing mail.", status: 500 });
  if (!getProcessPlatformPermissions().includes("mail:send"))
    return fail({ code: "mail_not_declared", message: 'Declare platformPermissions: ["mail:send"].', status: 403 });
  return ok(appId);
};
const failure = (error: unknown): MailServiceError => {
  if (!(error instanceof OutgoingMailError))
    return { code: "mail_unavailable", message: "Outgoing mail storage is unavailable.", status: 500 };
  return {
    code: error.code,
    message: error.message,
    status: error.code === "mail_unavailable" || error.status === 502 ? 500 : error.status,
    ...("limit" in error && typeof error.limit === "number" ? { limit: error.limit } : {}),
    ...("used" in error && typeof error.used === "number" ? { used: error.used } : {}),
    ...("requested" in error && typeof error.requested === "number" ? { requested: error.requested } : {}),
  };
};
export const mail = {
  async enqueue(messages: MailMessage[]): Promise<Result<{ batchId: string; ids: string[] }, MailServiceError>> {
    const caller = identity();
    const parsed = caller.ok ? MailBatchSchema.safeParse(messages) : undefined;
    const cancel = () => {
      if (Array.isArray(messages)) for (const message of messages) cancelMailStreams(message?.attachments);
    };
    if (!caller.ok || !parsed?.success) {
      cancel();
      const appId = getProcessApplicationId();
      const issue: MailServiceError = caller.ok
        ? { code: "bad_input", message: "Provide 1–1000 valid messages with distinct keys.", status: 400 }
        : caller.error;
      if (appId)
        await recordMailBatch(appId, Array.isArray(messages) ? messages : [], [], undefined, undefined, issue.code).catch(() => {});
      return fail(issue);
    }
    try {
      return ok(await enqueueMail(caller.data, parsed.data));
    } catch (error) {
      cancel();
      const issue = failure(error);
      await recordMailBatch(caller.data, parsed.data, [], undefined, undefined, issue.code).catch(() => {});
      return fail(issue);
    }
  },
  async profiles(): Promise<Result<MailProfile[], MailServiceError>> {
    const caller = identity();
    if (!caller.ok) return caller;
    try {
      return ok(await outgoingMailStore.profilesForApp(caller.data));
    } catch {
      return fail(failure(undefined));
    }
  },
  async send(message: MailMessage, options?: { signal?: AbortSignal }): Promise<Result<MailRecord, MailServiceError>> {
    const caller = identity();
    if (!caller.ok) {
      cancelMailStreams(message?.attachments);
      const appId = getProcessApplicationId();
      if (appId) await recordMailSend(appId, message, undefined, undefined, caller.error.code).catch(() => {});
      return caller;
    }
    const parsed = MailMessageSchema.safeParse(message);
    if (!parsed.success) {
      cancelMailStreams(message?.attachments);
      await recordMailSend(caller.data, message, undefined, undefined, "bad_input").catch(() => {});
      return fail({ code: "bad_input", message: "Invalid outgoing mail message.", status: 400 });
    }
    try {
      return ok(await sendMail(caller.data, parsed.data, options?.signal));
    } catch (error) {
      cancelMailStreams(message?.attachments);
      const issue = failure(error);
      await recordMailSend(caller.data, parsed.data, undefined, undefined, issue.code).catch(() => {});
      return fail(issue);
    }
  },
  async list(filter: MailFilter = {}, page: MailPageParams = {}): Promise<Result<MailPage, MailServiceError>> {
    const caller = identity();
    if (!caller.ok) return caller;
    const parsedFilter = MailFilterSchema.safeParse(filter);
    const parsedPage = MailPageParamsSchema.safeParse(page);
    if (!parsedFilter.success || !parsedPage.success)
      return fail({ code: "bad_input", message: "Invalid outgoing mail filter or page.", status: 400 });
    try {
      return ok(await outgoingMailMessages.list({ ...parsedFilter.data, app: caller.data }, parsedPage.data));
    } catch (error) {
      return fail(failure(error));
    }
  },
};
