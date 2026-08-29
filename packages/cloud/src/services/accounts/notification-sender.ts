import type { TypedNotificationSendResult } from "../notifications/platform";

export type AccountNotificationDeliveryResult = Pick<TypedNotificationSendResult, "id" | "status">;

export type AccountsNotificationSender = {
  sendLoginLink: (input: { email: string; token: string; magicLink: string; locale?: string }) => Promise<AccountNotificationDeliveryResult>;
  sendFreeIpaWelcome: (input: {
    userId: string;
    uid: string;
    temporaryPassword: string;
    accountExpires: string | null;
    locale?: string;
  }) => Promise<AccountNotificationDeliveryResult>;
  sendLocalWelcome: (input: { userId: string; email: string; accountExpires: string | null; locale?: string }) => Promise<AccountNotificationDeliveryResult>;
  sendRequestDenied: (input: {
    requestId: string;
    userId: string;
    firstName: string;
    reason: string;
    sentBy: string;
    locale?: string;
  }) => Promise<AccountNotificationDeliveryResult>;
  sendAdministrativeMessage: (input: {
    idempotencyKey: string;
    userId: string;
    subject: string;
    rawHtml: string;
    sentBy: string;
    locale?: string;
  }) => Promise<AccountNotificationDeliveryResult>;
};
