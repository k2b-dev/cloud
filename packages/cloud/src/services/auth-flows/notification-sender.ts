export type AuthNotificationDeliveryResult = {
  id: string;
  status: "queued" | "delivered" | "suppressed" | "error";
};

export type AuthNotificationSender = {
  sendMagicLink: (input: { email: string; token: string; magicLink: string; locale?: string }) => Promise<AuthNotificationDeliveryResult>;
  sendIpaLoginHint: (input: { email: string; loginUrl: string; locale?: string }) => Promise<AuthNotificationDeliveryResult>;
  sendPasswordReset: (input: { email: string; resetLink: string; locale?: string }) => Promise<AuthNotificationDeliveryResult>;
};
