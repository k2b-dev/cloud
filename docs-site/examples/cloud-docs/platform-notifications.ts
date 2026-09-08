import { browserNotificationClient } from "@valentinkolb/cloud/browser/notifications";
import { type NotificationChannelDriver, registerNotificationChannel } from "@valentinkolb/cloud/services";

declare module "@valentinkolb/cloud/contracts/notifications" {
  interface NotificationChannelRegistry {
    sms: true;
  }
}

declare const resolvePhoneNumber: (recipient: { userId: string | null; email: string | null }) => Promise<string | null>;
declare const smsProvider: {
  send(payload: { phone: string; text: string }): Promise<void>;
};

const smsDriver: NotificationChannelDriver = {
  id: "sms",
  async resolveDestinations(recipient) {
    const phone = await resolvePhoneNumber(recipient);
    return phone ? [{ key: phone, label: "SMS", context: { phone } }] : [];
  },
  createPayload({ presentation, destination }) {
    return {
      phone: (destination.context as { phone: string }).phone,
      text: [presentation.title, presentation.body].filter(Boolean).join("\n"),
    };
  },
  async deliver(payload) {
    await smsProvider.send(payload as { phone: string; text: string });
  },
};

export const registerSmsNotifications = (): (() => void) => registerNotificationChannel(smsDriver);

export const browserNotifications = {
  state: browserNotificationClient.state,
  refreshExisting: browserNotificationClient.refreshExisting,
  enable: browserNotificationClient.enable,
  disable: browserNotificationClient.disable,
};
