/**
 * Notification delivery, batch campaigns, and announcements.
 */
import { arg, command, confirmFlag, flag, paginationFlags, readCliInput } from "../index";
import {
  apiGet,
  apiJson,
  type Pagination,
  pageQuery,
  printJsonOrTable,
  queryString,
  readJsonInput,
  readOptionalInput,
  truncate,
} from "./shared";

export type Notification = {
  id: string;
  recipient: string;
  subject: string;
  status: "sent" | "pending" | "error";
  error: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type NotificationBatchStatus = "draft" | "ready" | "running" | "completed" | "completed_with_errors" | "failed" | "cancelled";
export type NotificationRecipientStatus = "pending" | "sending" | "sent" | "skipped" | "error";

export type NotificationBatch = {
  id: string;
  subject: string;
  bodyMarkdown: string;
  selection: Record<string, unknown>;
  selectionHash: string;
  status: NotificationBatchStatus;
  createdAt: string;
  finalizedAt: string | null;
  targetCount: number;
  deliverableCount: number;
  sentCount: number;
  skippedCount: number;
  errorCount: number;
  lastError: string | null;
};

export type NotificationBatchRecipient = {
  batchId: string;
  userId: string;
  recipient: string | null;
  uid: string;
  displayName: string;
  provider: "local" | "ipa";
  profile: "user" | "guest";
  status: NotificationRecipientStatus;
  notificationId: string | null;
  outgoingMailId: string | null;
  outgoingMailStatus: string | null;
  error: string | null;
  attemptCount: number;
  sentAt: string | null;
  updatedAt: string;
};

export type NotificationBatchPreview = {
  targetCount: number;
  deliverableCount: number;
  skippedNoEmailCount: number;
  duplicateCount: number;
  recipientHash: string;
};

export type Announcement = {
  id: string;
  version: number;
  kind: "announcement" | "banner";
  title: string;
  tone: "info" | "success" | "warning" | "danger";
  publishedAt: string;
  expiresAt: string | null;
};

export const parseExpiresAt = (value: string | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === "never" || value === "null") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('--expires-at must be an ISO timestamp, "never", or "null".');
  return date.toISOString();
};

export const announcementRows = (items: Announcement[]) =>
  items.map((item) => ({
    version: item.version,
    kind: item.kind,
    tone: item.tone,
    title: item.title,
    published: item.publishedAt,
    expires: item.expiresAt ?? "",
    id: item.id,
  }));

export const batchRows = (items: NotificationBatch[]) =>
  items.map((batch) => ({
    status: batch.status,
    subject: truncate(batch.subject, 72),
    targets: batch.targetCount,
    deliverable: batch.deliverableCount,
    sent: batch.sentCount,
    errors: batch.errorCount,
    created: batch.createdAt,
    id: batch.id,
  }));

export const previewRows = (preview: NotificationBatchPreview) => [
  {
    targets: preview.targetCount,
    deliverable: preview.deliverableCount,
    skippedNoEmail: preview.skippedNoEmailCount,
    duplicates: preview.duplicateCount,
    recipientHash: preview.recipientHash,
  },
];

export const notificationCommands = [
  command("notifications list", {
    summary: "List email notifications",
    flags: {
      search: flag.string({ aliases: ["q"], description: "Search notifications" }),
      status: flag.enum(["sent", "pending", "error"], { description: "Notification status" }),
      ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<{ notifications: Notification[]; pagination: Pagination }>(
        ctx,
        `/api/notifications${queryString({ search: flags.search, status: flags.status, ...pageQuery(flags) })}`,
      );
      const rows = result.notifications.map((item) => ({
        status: item.status,
        recipient: item.recipient,
        subject: truncate(item.subject, 72),
        error: truncate(item.error, 48),
        created: item.createdAt,
        id: item.id,
      }));
      printJsonOrTable(ctx, result, rows, [
        { key: "status" },
        { key: "recipient" },
        { key: "subject" },
        { key: "error" },
        { key: "created" },
        { key: "id" },
      ]);
    },
  }),
  command("notifications summary", {
    summary: "Show notification status summary",
    run: async ({ ctx }) => {
      const result = await apiGet<Record<string, number>>(ctx, "/api/notifications/summary");
      printJsonOrTable(ctx, result, [result], [{ key: "sent" }, { key: "pending" }, { key: "error" }]);
    },
  }),
  command("notifications get", {
    summary: "Show one notification",
    args: { id: arg.required({ valueLabel: "id" }) },
    run: async ({ ctx, args }) => {
      const result = await apiGet<Notification>(ctx, `/api/notifications/${encodeURIComponent(args.id)}`);
      printJsonOrTable(
        ctx,
        result,
        [result as unknown as Record<string, unknown>],
        [
          { key: "status" },
          { key: "recipient" },
          { key: "subject" },
          { key: "error" },
          { key: "sentAt" },
          { key: "createdAt" },
          { key: "id" },
        ],
      );
    },
  }),
  command("notifications resend", {
    summary: "Resend a pending or failed notification",
    args: { id: arg.required({ valueLabel: "id" }) },
    flags: { yes: confirmFlag("Confirm resending this notification") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to resend a notification without --yes.");
      const result = await apiJson<{ message: string }>(ctx, "POST", `/api/notifications/${encodeURIComponent(args.id)}/resend`);
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(result.message);
    },
  }),
  command("notifications pending-system", {
    summary: "Show pending system notification count",
    run: async ({ ctx }) => {
      const result = await apiGet<{ count: number }>(ctx, "/api/notifications/pending-system/count");
      printJsonOrTable(ctx, result, [result], [{ key: "count" }]);
    },
  }),
  command("notifications send-pending-system", {
    summary: "Send all pending system notifications",
    flags: { yes: confirmFlag("Confirm sending all pending system notifications") },
    run: async ({ ctx, flags }) => {
      if (!flags.yes) throw new Error("Refusing to send all pending system notifications without --yes.");
      const result = await apiJson<unknown>(ctx, "POST", "/api/notifications/pending-system/send-all");
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print("Pending system notification send submitted.");
    },
  }),
  command("notification-batches list", {
    summary: "List account notification batches",
    flags: {
      status: flag.enum(["draft", "ready", "running", "completed", "completed_with_errors", "failed", "cancelled"], {
        description: "Batch status",
      }),
      ...paginationFlags({ defaultPerPage: 50, maxPerPage: 100 }),
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<{ batches: NotificationBatch[]; pagination: Pagination }>(
        ctx,
        `/api/accounts/notifications/batches${queryString({ status: flags.status, ...pageQuery(flags) })}`,
      );
      printJsonOrTable(ctx, result, batchRows(result.batches), [
        { key: "status" },
        { key: "subject" },
        { key: "targets" },
        { key: "deliverable" },
        { key: "sent" },
        { key: "errors" },
        { key: "created" },
        { key: "id" },
      ]);
    },
  }),
  command("notification-batches preview", {
    summary: "Resolve notification batch recipients from a selection JSON body",
    flags: {
      selection: flag.input({
        fileName: "selection-file",
        fileAliases: ["f"],
        required: true,
        description: "Audience selection JSON",
      }),
    },
    run: async ({ ctx, flags }) => {
      const selection = await readJsonInput<Record<string, unknown>>(flags.selection, "notification batch selection");
      const result = await apiJson<NotificationBatchPreview>(ctx, "POST", "/api/accounts/notifications/batches/preview", { selection });
      printJsonOrTable(ctx, result, previewRows(result), [
        { key: "targets" },
        { key: "deliverable" },
        { key: "skippedNoEmail" },
        { key: "duplicates" },
        { key: "recipientHash" },
      ]);
    },
  }),
  command("notification-batches create", {
    summary: "Create a draft account notification batch",
    flags: {
      subject: flag.string({ required: true, description: "Email subject" }),
      body: flag.input({
        fileName: "body-file",
        fileAliases: ["b"],
        required: true,
        description: "Markdown body",
      }),
      selection: flag.input({
        fileName: "selection-file",
        fileAliases: ["f"],
        required: true,
        description: "Audience selection JSON",
      }),
    },
    run: async ({ ctx, flags }) => {
      const [bodyMarkdown, selection] = await Promise.all([
        readCliInput(flags.body, { label: "notification batch body", required: true }),
        readJsonInput<Record<string, unknown>>(flags.selection, "notification batch selection"),
      ]);
      const result = await apiJson<NotificationBatch>(ctx, "POST", "/api/accounts/notifications/batches", {
        subject: flags.subject,
        bodyMarkdown,
        selection,
      });
      const row = batchRows([result])[0]!;
      printJsonOrTable(
        ctx,
        result,
        [row],
        [
          { key: "status" },
          { key: "subject" },
          { key: "targets" },
          { key: "deliverable" },
          { key: "sent" },
          { key: "errors" },
          { key: "created" },
          { key: "id" },
        ],
      );
    },
  }),
  command("notification-batches get", {
    summary: "Show one account notification batch",
    args: { id: arg.required({ valueLabel: "id" }) },
    run: async ({ ctx, args }) => {
      const result = await apiGet<NotificationBatch>(ctx, `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}`);
      const row = batchRows([result])[0]!;
      printJsonOrTable(
        ctx,
        result,
        [row],
        [
          { key: "status" },
          { key: "subject" },
          { key: "targets" },
          { key: "deliverable" },
          { key: "sent" },
          { key: "errors" },
          { key: "created" },
          { key: "id" },
        ],
      );
    },
  }),
  command("notification-batches finalize", {
    summary: "Finalize a draft batch and submit async delivery",
    args: { id: arg.required({ valueLabel: "batch-id" }) },
    flags: { yes: confirmFlag("Confirm finalizing and sending this notification batch") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to finalize a notification batch without --yes.");
      const batch = await apiGet<NotificationBatch>(ctx, `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}`);
      if (batch.status !== "draft") throw new Error(`Only draft batches can be finalized. Current status: ${batch.status}.`);
      const preview = await apiJson<NotificationBatchPreview>(ctx, "POST", "/api/accounts/notifications/batches/preview", {
        selection: batch.selection,
      });
      if (preview.deliverableCount <= 0) throw new Error("No deliverable recipients match this notification batch.");
      const result = await apiJson<{ batch: NotificationBatch; jobId: string }>(
        ctx,
        "POST",
        `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}/finalize`,
        {
          expectedSelectionHash: batch.selectionHash,
          expectedDeliverableCount: preview.deliverableCount,
          expectedRecipientHash: preview.recipientHash,
        },
      );
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Finalized batch ${result.batch.id}. Delivery job: ${result.jobId}`);
    },
  }),
  command("notification-batches recipients", {
    summary: "List account notification batch recipients",
    args: { id: arg.required({ valueLabel: "batch-id" }) },
    flags: {
      status: flag.enum(["pending", "sending", "sent", "skipped", "error"], { description: "Recipient status" }),
      ...paginationFlags({ defaultPerPage: 100, maxPerPage: 100 }),
    },
    run: async ({ ctx, args, flags }) => {
      const result = await apiGet<{ recipients: NotificationBatchRecipient[]; pagination: Pagination }>(
        ctx,
        `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}/recipients${queryString({
          status: flags.status,
          ...pageQuery(flags),
        })}`,
      );
      const rows = result.recipients.map((recipient) => ({
        status: recipient.status,
        user: recipient.displayName || recipient.uid,
        uid: recipient.uid,
        email: recipient.recipient ?? "",
        provider: recipient.provider,
        profile: recipient.profile,
        attempts: recipient.attemptCount,
        mailId: recipient.outgoingMailId ?? "",
        mailStatus: recipient.outgoingMailStatus ?? "",
        error: truncate(recipient.error, 60),
        userId: recipient.userId,
      }));
      printJsonOrTable(ctx, result, rows, [
        { key: "status" },
        { key: "user" },
        { key: "uid" },
        { key: "email" },
        { key: "provider" },
        { key: "profile" },
        { key: "attempts" },
        { key: "mailId" },
        { key: "mailStatus" },
        { key: "error" },
        { key: "userId" },
      ]);
    },
  }),
  command("notification-batches retry-failed", {
    summary: "Retry all failed recipients in a finalized batch",
    args: { id: arg.required({ valueLabel: "batch-id" }) },
    flags: { yes: confirmFlag("Confirm retrying failed notification recipients") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to retry failed recipients without --yes.");
      const result = await apiJson<{ batch: NotificationBatch; jobId: string }>(
        ctx,
        "POST",
        `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}/retry-failed`,
      );
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Retry submitted: ${result.jobId}`);
    },
  }),
  command("notification-batches retry-recipient", {
    summary: "Retry one failed recipient in a finalized batch",
    args: {
      id: arg.required({ valueLabel: "batch-id" }),
      userId: arg.required({ valueLabel: "user-id" }),
    },
    flags: { yes: confirmFlag("Confirm retrying the failed notification recipient") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to retry a recipient without --yes.");
      const result = await apiJson<{ batch: NotificationBatch; jobId: string }>(
        ctx,
        "POST",
        `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}/recipients/${encodeURIComponent(args.userId)}/retry`,
      );
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Retry submitted: ${result.jobId}`);
    },
  }),
  command("notification-batches delete-draft", {
    summary: "Delete a draft account notification batch",
    args: { id: arg.required({ valueLabel: "batch-id" }) },
    flags: { yes: confirmFlag("Confirm deleting the draft notification batch") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to delete a draft notification batch without --yes.");
      const result = await apiJson<{ id: string }>(ctx, "DELETE", `/api/accounts/notifications/batches/${encodeURIComponent(args.id)}`);
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Deleted draft ${result.id}.`);
    },
  }),
  command("announcements list", {
    summary: "List platform announcements and banners",
    flags: {
      kind: flag.enum(["announcement", "banner"], { description: "Announcement kind" }),
      search: flag.string({ aliases: ["q"], description: "Search title or body" }),
    },
    run: async ({ ctx, flags }) => {
      const result = await apiGet<{ items: Announcement[] }>(
        ctx,
        `/api/admin/core/announcements${queryString({ kind: flags.kind, search: flags.search })}`,
      );
      printJsonOrTable(ctx, result, announcementRows(result.items), [
        { key: "version" },
        { key: "kind" },
        { key: "tone" },
        { key: "title" },
        { key: "published" },
        { key: "expires" },
        { key: "id" },
      ]);
    },
  }),
  command("announcements create", {
    summary: "Create an announcement or banner",
    flags: {
      kind: flag.enum(["announcement", "banner"], { default: "announcement", description: "Entry kind" }),
      title: flag.string({ required: true, description: "Entry title" }),
      body: flag.input({ required: true, description: "Markdown body" }),
      tone: flag.enum(["info", "success", "warning", "danger"], { default: "info", description: "Visual tone" }),
      publishedAt: flag.string({ name: "published-at", description: "ISO publish timestamp" }),
      expiresAt: flag.string({ name: "expires-at", description: "ISO expiry timestamp, never, or null" }),
    },
    run: async ({ ctx, flags }) => {
      const body = await readCliInput(flags.body, { label: "announcement body", required: true });
      const result = await apiJson<Announcement>(ctx, "POST", "/api/admin/core/announcements", {
        kind: flags.kind,
        title: flags.title,
        body,
        tone: flags.tone,
        publishedAt: flags.publishedAt,
        expiresAt: parseExpiresAt(flags.expiresAt),
      });
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Created ${result.kind} v${result.version}: ${result.title}`);
    },
  }),
  command("announcements update", {
    summary: "Update an announcement or banner",
    args: { id: arg.required({ valueLabel: "id" }) },
    flags: {
      kind: flag.enum(["announcement", "banner"], { description: "Entry kind" }),
      title: flag.string({ description: "Entry title" }),
      body: flag.input({ description: "Markdown body" }),
      tone: flag.enum(["info", "success", "warning", "danger"], { description: "Visual tone" }),
      publishedAt: flag.string({ name: "published-at", description: "ISO publish timestamp" }),
      expiresAt: flag.string({ name: "expires-at", description: "ISO expiry timestamp, never, or null" }),
    },
    run: async ({ ctx, args, flags }) => {
      const body = await readOptionalInput(flags.body, "announcement body");
      const payload: Record<string, unknown> = {};
      if (flags.kind) payload.kind = flags.kind;
      if (flags.title) payload.title = flags.title;
      if (body !== undefined) payload.body = body;
      if (flags.tone) payload.tone = flags.tone;
      if (flags.publishedAt) payload.publishedAt = flags.publishedAt;
      const expiresAt = parseExpiresAt(flags.expiresAt);
      if (expiresAt !== undefined) payload.expiresAt = expiresAt;
      const result = await apiJson<Announcement>(ctx, "PATCH", `/api/admin/core/announcements/${encodeURIComponent(args.id)}`, payload);
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(`Updated ${result.kind} v${result.version}: ${result.title}`);
    },
  }),
  command("announcements delete", {
    summary: "Delete an announcement or banner",
    args: { id: arg.required({ valueLabel: "id" }) },
    flags: { yes: confirmFlag("Confirm announcement deletion") },
    run: async ({ ctx, args, flags }) => {
      if (!flags.yes) throw new Error("Refusing to delete an announcement without --yes.");
      const result = await apiJson<{ message: string }>(ctx, "DELETE", `/api/admin/core/announcements/${encodeURIComponent(args.id)}`);
      if (ctx.options.output === "json") ctx.json(result);
      else ctx.print(result.message);
    },
  }),
];
