import { createHash } from "node:crypto";
import type { EmailNotificationPresentation, NotificationChannelId, NotificationPresentation } from "../../contracts/notification-types";
import { notificationMailOutcome, notificationMailOutcomeById, sendNotificationMail } from "./email-mail";

export type ResolvedNotificationRecipient = {
  userId: string | null;
  email: string | null;
};

export type NotificationDestination = {
  key: string;
  label: string;
  endpointId?: string;
  context: unknown;
};

export type NotificationChannelDriver = {
  id: NotificationChannelId | (string & {});
  resolveDestinations: (recipient: ResolvedNotificationRecipient) => Promise<NotificationDestination[]>;
  createPayload: (input: {
    presentation: NotificationPresentation;
    email?: EmailNotificationPresentation;
    destination: NotificationDestination;
    event: { id: string; definitionId: string };
  }) => unknown;
  deliver: (
    payload: unknown,
    context?: { deliveryId: string; signal?: AbortSignal; outgoingMailId?: string },
  ) => Promise<
    | void
    | {
        status: "delivered";
        outgoingMailId?: string;
      }
    | {
        status: "pending";
        retryAfterMs: number;
        outgoingMailId?: string;
        errorMessage?: string | null;
      }
  >;
};

const drivers = new Map<string, NotificationChannelDriver>();

export const registerNotificationChannel = (driver: NotificationChannelDriver): (() => void) => {
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(driver.id)) {
    throw new Error("Notification channel id must be a lowercase identifier of at most 80 characters");
  }
  const existing = drivers.get(driver.id);
  if (existing && existing !== driver) throw new Error(`Notification channel "${driver.id}" is already registered`);
  drivers.set(driver.id, driver);
  return () => {
    if (drivers.get(driver.id) === driver) drivers.delete(driver.id);
  };
};

export const getNotificationChannel = (id: string): NotificationChannelDriver | undefined => drivers.get(id);

export const listNotificationChannels = (): string[] => [...drivers.keys()].sort();

const normalizeEmail = (value: string): string => value.trim().toLowerCase();
const emailKey = (value: string): string => createHash("sha256").update(normalizeEmail(value)).digest("hex");

const emailLabel = (value: string): string => {
  const [local = "", domain = ""] = normalizeEmail(value).split("@", 2);
  if (!domain) return "Email";
  return `${local.slice(0, 1) || "*"}***@${domain}`;
};

type EmailPayload = {
  to: string;
  subject: string;
  content?: string;
  rawHtml?: string;
};

const parseEmailPayload = (value: unknown): EmailPayload => {
  if (!value || typeof value !== "object") throw new Error("Invalid email notification payload");
  const payload = value as Partial<EmailPayload>;
  if (typeof payload.to !== "string" || typeof payload.subject !== "string") {
    throw new Error("Invalid email notification payload");
  }
  if (payload.content !== undefined && typeof payload.content !== "string") throw new Error("Invalid email notification payload");
  if (payload.rawHtml !== undefined && typeof payload.rawHtml !== "string") throw new Error("Invalid email notification payload");
  return { to: payload.to, subject: payload.subject, content: payload.content, rawHtml: payload.rawHtml };
};

const emailDriver: NotificationChannelDriver = {
  id: "email",
  resolveDestinations: async (recipient) => {
    if (!recipient.email) return [];
    const email = normalizeEmail(recipient.email);
    return [{ key: emailKey(email), label: emailLabel(email), context: { email } }];
  },
  createPayload: ({ presentation, email, destination }) => {
    const context = destination.context as { email?: unknown };
    if (typeof context.email !== "string") throw new Error("Email destination is missing an address");
    return {
      to: context.email,
      subject: email?.subject ?? presentation.title,
      content: email?.content ?? presentation.body,
      rawHtml: email?.rawHtml,
    } satisfies EmailPayload;
  },
  deliver: async (value, context) => {
    if (context?.outgoingMailId) return notificationMailOutcomeById(context.outgoingMailId);
    const payload = parseEmailPayload(value);
    return notificationMailOutcome(
      await sendNotificationMail(
        payload.to,
        payload.subject,
        {
          content: payload.content,
          rawHtml: payload.rawHtml,
        },
        context ? `notification-delivery:${context.deliveryId}` : undefined,
        context?.signal,
      ),
    );
  },
};

registerNotificationChannel(emailDriver);
