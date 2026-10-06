import { createHash } from "node:crypto";
import { type BoundNotificationMap, type NotificationDeliveryPolicy, notification } from "@k2b/cloud";
import { notifications, renderTemplate } from "@k2b/cloud/services";
import type { AccountNotificationDeliveryResult, AccountsNotificationSender } from "@k2b/cloud/services/accounts/notification-sender";
import * as settings from "@k2b/cloud/services/settings";
import { dates, i18n } from "@k2b/stdlib";
import { z } from "zod";

const requiredEmail: NotificationDeliveryPolicy = { required: ["email"] };

const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });

const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      loginTitle: "Sign-in code",
      loginBody: "Enter this code or open the link in this email to sign in. Both work once.",
      loginSubject: ({ appName }: { appName: string }) => `Sign-in code for ${appName}`,
      accountReady: "Your account is ready",
      freeIpaReady: "Your FreeIPA-backed Cloud account has been created.",
      localReady: "Your local Cloud account has been created.",
      welcomeSubject: ({ appName }: { appName: string }) => `Welcome to ${appName}`,
      requestUpdate: "Account request update",
      requestReviewed: "Your account request was reviewed.",
      administrativeMessage: "You received a new message from the administration.",
      deviceRevoked: "Sign-in device revoked",
      deviceRevokedBody: ({ name }: { name: string }) =>
        `An administrator revoked the device “${name}”. It can no longer approve Cloud sign-ins. To keep using app sign-in, pair a device again or contact your administrator.`,
    },
    de: {
      loginTitle: "Anmeldecode",
      loginBody: "Melde dich mit diesem Code oder über den Link in dieser E-Mail an. Beides funktioniert einmalig.",
      loginSubject: ({ appName }) => `Anmeldecode für ${appName}`,
      accountReady: "Dein Konto ist bereit",
      freeIpaReady: "Dein FreeIPA-gestütztes Cloud-Konto wurde erstellt.",
      localReady: "Dein lokales Cloud-Konto wurde erstellt.",
      welcomeSubject: ({ appName }) => `Willkommen bei ${appName}`,
      requestUpdate: "Aktualisierung deiner Kontoanfrage",
      requestReviewed: "Deine Kontoanfrage wurde geprüft.",
      administrativeMessage: "Du hast eine neue Nachricht von der Administration erhalten.",
      deviceRevoked: "Anmeldegerät widerrufen",
      deviceRevokedBody: ({ name }) =>
        `Die Administration hat das Gerät „${name}“ widerrufen. Es kann keine Cloud-Anmeldungen mehr bestätigen. Um die App-Anmeldung weiter zu nutzen, kopple erneut ein Gerät oder wende dich an die Administration.`,
    },
  },
});

const text = (locale: string) => notificationMessages.resolve([locale]).t;
const configuredLocale = (locale?: string): Promise<string> => (locale ? Promise.resolve(locale) : settings.get<string>("app.locale"));

const applicationUrl = async (): Promise<string> => {
  const configured = await settings.get<string>("app.url");
  return /^https?:\/\//.test(configured) ? configured : `https://${configured}`;
};

export const NOTIFICATIONS = {
  loginLink: notification({
    recipient: "email",
    label: "Administrative login links",
    description: "Required when an administrator sends a one-time sign-in link to a local account.",
    presentation: presentation(
      "Administrative Anmeldelinks",
      "Erforderlich, wenn die Administration einen einmaligen Anmeldelink an ein lokales Konto sendet.",
    ),
    delivery: requiredEmail,
    data: z.object({ token: z.string(), magicLink: z.string().url() }),
    render: (_, { locale }) => ({ title: text(locale).loginTitle, body: text(locale).loginBody }),
    email: async ({ token, magicLink }, { locale }) => {
      const [appName, template] = await Promise.all([settings.get<string>("app.name"), settings.get<string>("mail.magic_link_login")]);
      return {
        subject: text(locale).loginSubject({ appName }),
        rawHtml: renderTemplate(template, { TOKEN: token, MAGIC_LINK: magicLink, APP_NAME: appName }),
      };
    },
  }),
  freeIpaWelcome: notification({
    recipient: "user",
    label: "FreeIPA account onboarding",
    description: "Required onboarding details and the temporary password for a newly created FreeIPA account.",
    presentation: presentation(
      "Einrichtung von FreeIPA-Konten",
      "Erforderliche Zugangsdaten und das vorläufige Passwort für ein neu erstelltes FreeIPA-Konto.",
    ),
    delivery: requiredEmail,
    data: z.object({ uid: z.string(), temporaryPassword: z.string(), accountExpires: z.string().nullable() }),
    render: (_, { locale }) => ({ title: text(locale).accountReady, body: text(locale).freeIpaReady }),
    email: async ({ uid, temporaryPassword, accountExpires }, { locale }) => {
      const [template, contactEmail, appName, baseUrl] = await Promise.all([
        settings.get<string>("mail.user_welcome_freeipa"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("app.name"),
        applicationUrl(),
      ]);
      return {
        subject: text(locale).welcomeSubject({ appName }),
        rawHtml: renderTemplate(template, {
          USERNAME: uid,
          PASSWORD: temporaryPassword,
          EXPIRY: accountExpires ? dates.formatDate(accountExpires, { locale }) : "",
          LOGIN_URL: `${baseUrl}/auth/login?method=ipa&ipa-uid=${encodeURIComponent(uid)}`,
          CONTACT_EMAIL: contactEmail,
          APP_NAME: appName,
        }),
      };
    },
  }),
  localWelcome: notification({
    recipient: "user",
    label: "Local account onboarding",
    description: "Required sign-in guidance for a newly created local account.",
    presentation: presentation("Einrichtung lokaler Konten", "Erforderliche Anmeldehinweise für ein neu erstelltes lokales Konto."),
    delivery: requiredEmail,
    data: z.object({ email: z.string().email(), accountExpires: z.string().nullable() }),
    render: (_, { locale }) => ({ title: text(locale).accountReady, body: text(locale).localReady }),
    email: async ({ email, accountExpires }, { locale }) => {
      const [template, contactEmail, appName, baseUrl] = await Promise.all([
        settings.get<string>("mail.user_welcome_local"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("app.name"),
        applicationUrl(),
      ]);
      return {
        subject: text(locale).welcomeSubject({ appName }),
        rawHtml: renderTemplate(template, {
          EMAIL: email,
          EXPIRY: accountExpires ? dates.formatDate(accountExpires, { locale }) : "",
          LOGIN_URL: `${baseUrl}/auth/login`,
          CONTACT_EMAIL: contactEmail,
          APP_NAME: appName,
        }),
      };
    },
  }),
  accountRequestDenied: notification({
    recipient: "user",
    label: "Account request decisions",
    description: "Required explanation when an account request is denied with a reason.",
    presentation: presentation("Entscheidungen über Kontoanfragen", "Erforderliche Begründung, wenn eine Kontoanfrage abgelehnt wird."),
    delivery: requiredEmail,
    data: z.object({ firstName: z.string(), reason: z.string() }),
    render: (_, { locale }) => ({ title: text(locale).requestUpdate, body: text(locale).requestReviewed }),
    email: async ({ firstName, reason }, { locale }) => {
      const [template, contactEmail, appName] = await Promise.all([
        settings.get<string>("mail.account_request_denial"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("app.name"),
      ]);
      return {
        subject: text(locale).requestUpdate,
        rawHtml: renderTemplate(template, { FIRST_NAME: firstName, REASON: reason, CONTACT_EMAIL: contactEmail, APP_NAME: appName }),
      };
    },
  }),
  administrativeMessage: notification({
    recipient: "user",
    label: "Administrative messages",
    description: "Messages sent directly to an account by an administrator.",
    presentation: presentation("Nachrichten der Administration", "Nachrichten, die die Administration direkt an ein Konto sendet."),
    delivery: { recommended: ["email"] },
    data: z.object({ subject: z.string(), rawHtml: z.string() }),
    render: ({ subject }, { locale }) => ({ title: subject, body: text(locale).administrativeMessage, targetHref: "/me/notifications" }),
    email: ({ subject, rawHtml }) => ({ subject, rawHtml }),
  }),
  deviceRevoked: notification({
    recipient: "user",
    label: "Sign-in device revoked",
    description: "Security notice when an administrator revokes a device that approves Cloud sign-ins.",
    presentation: presentation(
      "Anmeldegerät widerrufen",
      "Sicherheitshinweis, wenn die Administration ein Gerät widerruft, das Cloud-Anmeldungen bestätigt.",
    ),
    // Best effort: a person without email still gets a browser notice where one is set up.
    delivery: { recommended: ["email", "browser"] },
    data: z.object({ name: z.string() }),
    render: ({ name }, { locale }) => ({
      title: text(locale).deviceRevoked,
      body: text(locale).deviceRevokedBody({ name }),
      targetHref: "/me/security",
    }),
    email: ({ name }, { locale }) => ({ subject: text(locale).deviceRevoked, content: text(locale).deviceRevokedBody({ name }) }),
  }),
};

type AccountsNotificationDescriptors = BoundNotificationMap<"accounts", typeof NOTIFICATIONS>;

export type AccountsAppNotificationSender = AccountsNotificationSender & {
  sendDeviceRevoked: (input: {
    deviceId: string;
    userId: string;
    name: string;
    sentBy: string;
    locale?: string;
  }) => Promise<AccountNotificationDeliveryResult>;
};

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

export const createAccountsNotificationSender = (definitions: AccountsNotificationDescriptors): AccountsAppNotificationSender => ({
  sendLoginLink: async ({ email, token, magicLink, locale }) =>
    notifications.send(definitions.loginLink, {
      recipient: { email },
      data: { token, magicLink },
      idempotencyKey: `login-link:${fingerprint(token)}`,
      locale: await configuredLocale(locale),
    }),
  sendFreeIpaWelcome: async ({ userId, uid, temporaryPassword, accountExpires, locale }) =>
    notifications.send(definitions.freeIpaWelcome, {
      recipient: { userId },
      data: { uid, temporaryPassword, accountExpires },
      idempotencyKey: `welcome:${userId}`,
      locale: await configuredLocale(locale),
    }),
  sendLocalWelcome: async ({ userId, email, accountExpires, locale }) =>
    notifications.send(definitions.localWelcome, {
      recipient: { userId },
      data: { email, accountExpires },
      idempotencyKey: `welcome:${userId}`,
      locale: await configuredLocale(locale),
    }),
  sendRequestDenied: async ({ requestId, userId, firstName, reason, sentBy, locale }) =>
    notifications.send(definitions.accountRequestDenied, {
      recipient: { userId },
      data: { firstName, reason },
      idempotencyKey: `request-denied:${requestId}`,
      sentBy,
      locale: await configuredLocale(locale),
    }),
  sendAdministrativeMessage: async ({ idempotencyKey, userId, subject, rawHtml, sentBy, locale }) =>
    notifications.send(definitions.administrativeMessage, {
      recipient: { userId },
      data: { subject, rawHtml },
      idempotencyKey,
      sentBy,
      locale: await configuredLocale(locale),
    }),
  sendDeviceRevoked: async ({ deviceId, userId, name, sentBy, locale }) =>
    notifications.send(definitions.deviceRevoked, {
      recipient: { userId },
      data: { name },
      idempotencyKey: `device-revoked:${deviceId}`,
      sentBy,
      locale: await configuredLocale(locale),
    }),
});
