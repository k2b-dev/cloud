import { defineApp } from "@k2b/cloud";
import type { MailMessage, MailPage, MailProfile, MailRecord, PlatformPermission } from "@k2b/cloud/contracts";
import { mail } from "@k2b/cloud/services";

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
