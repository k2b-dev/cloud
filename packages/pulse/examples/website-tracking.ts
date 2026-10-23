#!/usr/bin/env bun
import { z } from "zod";

/** Run in a website backend. Persist a delivery's body and key before sending it. */
export const WebsiteDeliverySchema = z.strictObject({
  key: z.string().min(1).max(200),
  events: z.array(
    z.strictObject({
      kind: z.enum(["page_view", "contact_form_sent"]),
      ts: z.string().datetime(),
      sessionId: z.string().min(1),
      path: z
        .string()
        .startsWith("/")
        .refine((path) => !/[?#]/.test(path), "Use a path without query or fragment"),
    }),
  ),
});
export type WebsiteDelivery = z.infer<typeof WebsiteDeliverySchema>;
export const sendWebsiteDelivery = async (
  delivery: WebsiteDelivery,
  config: { endpoint: string; token: string },
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> => {
  // Never include a query string, form content, email address or IP address.
  const batch = { events: delivery.events.map(({ path, ...event }) => ({ ...event, dimensions: { path } })) };
  const response = await transport(config.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", "idempotency-key": delivery.key },
    body: JSON.stringify(batch),
  });
  if (!response.ok) {
    // Leave the saved delivery pending. The backend queue can retry the same file/key
    // within 24 hours, respecting Retry-After for 429/503. Do not log the token.
    throw new Error(`Pulse delivery failed: HTTP ${response.status}; Retry-After=${response.headers.get("retry-after") ?? "none"}`);
  }
  return response;
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length !== 3 || args.includes("--help")) {
    console.log(
      "Usage: bun website-tracking.ts HTTPS_INGEST_URL TOKEN_FILE DELIVERY_JSON\nSend one persisted website-backend delivery. Failed deliveries exit nonzero; retry the unchanged file within 24 hours.",
    );
    process.exit(args.includes("--help") ? 0 : 2);
  }
  const [endpoint, tokenFile, deliveryFile] = args;
  if (new URL(endpoint!).protocol !== "https:") throw new Error("Use the HTTPS Cloud ingest endpoint");
  const delivery = WebsiteDeliverySchema.parse(await Bun.file(deliveryFile!).json());
  const response = await sendWebsiteDelivery(delivery, { endpoint: endpoint!, token: (await Bun.file(tokenFile!).text()).trim() });
  console.log(await response.text());
}
