import { defineApp } from "@k2b/cloud";
import type { MailFilter, MailMessage, MailPage, MailProfile, MailRecord, PlatformPermission, RequestActor } from "@k2b/cloud/contracts";
import { mail, renderHtmlToPdf } from "@k2b/cloud/services";

const permissions: readonly PlatformPermission[] = ["mail:send"];
export const outgoingMailApp = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Inventory",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
  platformPermissions: permissions,
});
/** Call after outgoingMailApp.start() completes. */
export const availableSenders = async (): Promise<MailProfile[]> => {
  const result = await mail.profiles();
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

/** Stream each attachment once, and use the returned status for delivery outcome. */
export const sendOrderMail = async (attachment: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<MailRecord> => {
  const message: MailMessage = {
    to: ["customer@example.org"],
    subject: "Your order",
    text: "Your order is ready.",
    html: "<p>Your order is ready.</p>",
    ref: { scope: "order", id: "42" },
    key: "order-42-ready",
    headers: { "X-Order": "42" },
    attachments: [{ filename: "order.txt", contentType: "text/plain", content: attachment }],
  };
  const result = await mail.send(message, { signal });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};
export const orderMailLog = async (cursor?: string): Promise<MailPage> => {
  const result = await mail.list({ ref: { scope: "order", id: "42" } }, { perPage: 20, cursor });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
export const enqueueStockMail = async (): Promise<MailPage> => {
  const batch = await mail.enqueue([
    { to: ["first@example.org"], subject: "Stock update", text: "New stock arrived.", key: "stock-42-first" },
    { to: ["second@example.org"], subject: "Stock update", text: "New stock arrived.", key: "stock-42-second" },
  ]);
  if (!batch.ok) throw new Error(`${batch.error.code}: ${batch.error.message}`);
  const status = await mail.list({ batchId: batch.data.batchId }, { perPage: 100 });
  if (!status.ok) throw new Error(status.error.message);
  return status.data;
};

export const sendInvoiceMail = async (
  invoice: { id: string; version: number; to: string; html: string },
  saveMailId: (invoiceId: string, recordId: string) => Promise<void>,
  actor?: RequestActor,
) => {
  const pdf = await renderHtmlToPdf({ html: invoice.html, title: `Invoice ${invoice.id}` });
  const result = await mail.send({
    to: [invoice.to],
    subject: `Invoice ${invoice.id}`,
    text: "Your issued invoice is attached.",
    attachments: [{ filename: `invoice-${invoice.id}.pdf`, contentType: pdf.contentType, content: pdf.pdf }],
    ref: { scope: "invoice", id: invoice.id },
    key: `invoice-${invoice.id}-v${invoice.version}`,
    actor,
  });
  if (!result.ok) {
    switch (result.error.code) {
      case "quota_exceeded":
        return { accepted: false, action: "retry_later" };
      case "attachments_too_large":
        return { accepted: false, action: "reduce_attachment" };
      case "profile_required":
        return { accepted: false, action: "choose_profile" };
      default:
        throw new Error(`${result.error.code}: ${result.error.message}`);
    }
  }
  await saveMailId(invoice.id, result.data.id);
  const status = result.data.status;
  const delivery = status === "queued" || status === "sending" ? "pending" : status;
  return { accepted: true, record: result.data, delivery };
};

type DownloadToken = { id: string; value: string; expiresAt: string };
type StoredDownloadToken = { id: string; downloadId: string; tokenHash: string; expiresAt: string };

export const sendDownloadLink = async (
  downloadId: string,
  to: string,
  origin: string,
  token: DownloadToken,
  storeToken: (token: StoredDownloadToken) => Promise<void>,
) => {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token.value)));
  const tokenHash = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await storeToken({ id: token.id, downloadId, tokenHash, expiresAt: token.expiresAt });
  const link = new URL("/downloads/confirm", origin);
  link.searchParams.set("token", token.value);
  return mail.send({
    to: [to],
    subject: "Your download link",
    text: `Download your file: ${link.href}`,
    ref: { scope: "download", id: downloadId },
    key: `download-link-${token.id}`,
  });
};

export const enqueueStockRun = async (
  runId: string,
  customers: { id: string; email: string }[],
  startOffset: number,
  saveBatch: (batch: { batchId: string; ids: string[]; nextOffset: number }) => Promise<void>,
) => {
  let size = 1000;
  for (let offset = startOffset; offset < customers.length; ) {
    const messages = customers.slice(offset, offset + size).map((customer) => ({
      to: [customer.email],
      subject: "Stock update",
      text: "New stock arrived. Visit our catalogue to see it.",
      key: `stock-${runId}-${customer.id}`,
    }));
    const batch = await mail.enqueue(messages);
    if (!batch.ok) {
      const { code, limit, used } = batch.error;
      if (code === "quota_exceeded" && limit !== undefined && used !== undefined && limit > used) {
        // Each rejected chunk shrinks, so retries terminate.
        size = limit - used;
        continue;
      }
      if (code === "backlog_full" || code === "quota_exceeded") return { nextOffset: offset, reason: code };
      throw new Error(`${code}: ${batch.error.message}`);
    }
    await saveBatch({ ...batch.data, nextOffset: offset + messages.length });
    offset += messages.length;
  }
  return { nextOffset: customers.length };
};

export const readStockBatch = async (batchId: string, cursor?: string) => {
  const filter: MailFilter = { batchId };
  const items: MailRecord[] = [];
  // At most 1000 messages per batch, with 100 records per page.
  for (let page = 0; page < 10; page++) {
    const result = await mail.list(filter, { perPage: 100, cursor });
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    items.push(...result.data.items);
    cursor = result.data.nextCursor;
    if (!cursor) break;
  }
  return { items, nextCursor: cursor };
};
