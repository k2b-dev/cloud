import { createHash } from "node:crypto";
import { type BoundNotificationMap, type NotificationDeliveryPolicy, notification } from "@k2b/cloud";
import { type AppDeviceEnrollmentNotice, notifications, type PwaDevicePairedNotice, renderTemplate } from "@k2b/cloud/services";
import type { AccountLifecycleNotificationSender } from "@k2b/cloud/services/account-lifecycle/notification-sender";
import type { AuthNotificationSender } from "@k2b/cloud/services/auth-flows";
import * as settings from "@k2b/cloud/services/settings";
import { dates, i18n } from "@k2b/stdlib";
import { z } from "zod";

const requiredEmail: NotificationDeliveryPolicy = { required: ["email"] };
type PwaPlatform = PwaDevicePairedNotice["platform"];
const platformLabel = (platform: PwaPlatform, other: string) => (platform === "ios" ? "iOS" : platform === "android" ? "Android" : other);
const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });

const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      deviceTitle: "New sign-in device linked",
      deviceBody: ({ name, assisted }: { name: string; assisted: boolean }) =>
        `The device “${name}” can now approve Cloud sign-ins.${assisted ? " An administrator helped link it." : ""} If this was not you, contact your administrator and revoke the device.`,
      signInCode: "Sign-in code",
      signInBody: "Enter this code or open the link in this email to sign in. Both work once.",
      signInSubject: ({ appName }: { appName: string }) => `Sign-in code for ${appName}`,
      ipaSignIn: "FreeIPA sign-in",
      ipaSignInBody: "Sign in with your FreeIPA account.",
      ipaSignInSubject: ({ appName }: { appName: string }) => `FreeIPA sign-in for ${appName}`,
      passwordReset: "Reset your password",
      passwordResetBody: "Open the link in this email to choose a new password.",
      passwordResetSubject: ({ appName }: { appName: string }) => `Reset your ${appName} password`,
      expiryTitle: "Account expires soon",
      expiryBody: ({ date }: { date: string }) => `Your account expires on ${date}.`,
      expirySubject: ({ appName }: { appName: string }) => `${appName} account expires soon`,
      phonePairedTitle: "New phone paired",
      phonePairedBody: ({ name, platform, time, where }: { name: string; platform: PwaPlatform; time: string; where: string }) =>
        `The phone “${name}” (${platformLabel(platform, "other platform")}) was paired with your account in the mobile app on ${time}. If this wasn't you, remove it ${where} and contact your administrator.`,
      phonePairedInApp: "under App in your profile menu",
      phonePairedAt: ({ url }: { url: string }) => `at ${url}`,
    },
    de: {
      deviceTitle: "Neues Anmeldegerät gekoppelt",
      deviceBody: ({ name, assisted }) =>
        `Das Gerät „${name}“ kann jetzt Cloud-Anmeldungen bestätigen.${assisted ? " Ein Administrator hat die Kopplung unterstützt." : ""} Falls du das nicht warst, kontaktiere deinen Administrator und widerrufe das Gerät.`,
      signInCode: "Anmeldecode",
      signInBody: "Melde dich mit diesem Code oder über den Link in dieser E-Mail an. Beides funktioniert einmalig.",
      signInSubject: ({ appName }) => `Anmeldecode für ${appName}`,
      ipaSignIn: "FreeIPA-Anmeldung",
      ipaSignInBody: "Melde dich mit deinem FreeIPA-Konto an.",
      ipaSignInSubject: ({ appName }) => `FreeIPA-Anmeldung bei ${appName}`,
      passwordReset: "Passwort zurücksetzen",
      passwordResetBody: "Öffne den Link in dieser E-Mail, um ein neues Passwort festzulegen.",
      passwordResetSubject: ({ appName }) => `Passwort für ${appName} zurücksetzen`,
      expiryTitle: "Dein Konto läuft bald ab",
      expiryBody: ({ date }) => `Dein Konto läuft am ${date} ab.`,
      expirySubject: ({ appName }) => `Dein Konto bei ${appName} läuft bald ab`,
      phonePairedTitle: "Neues Telefon gekoppelt",
      phonePairedBody: ({ name, platform, time, where }) =>
        `Das Telefon „${name}“ (${platformLabel(platform, "andere Plattform")}) wurde am ${time} in der Mobile App mit deinem Konto gekoppelt. Falls du das nicht warst, entferne es ${where} und wende dich an die Verwaltung.`,
      phonePairedInApp: "unter „App“ in deinem Profilmenü",
      phonePairedAt: ({ url }) => `unter ${url}`,
    },
  },
});

const text = (locale: string) => notificationMessages.resolve([locale]).t;
const configuredLocale = (locale?: string): Promise<string> => (locale ? Promise.resolve(locale) : settings.get<string>("app.locale"));

const absoluteUrl = async (path: string): Promise<string> => {
  const configured = (await settings.get<string>("app.url")).trim();
  if (!configured) return path;
  const baseUrl = configured.startsWith("http://") || configured.startsWith("https://") ? configured : `https://${configured}`;
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
};
const accountExtensionUrl = (): Promise<string> => absoluteUrl("/auth/extend");

/** The pairing time in the installation's timezone, named so that nobody has to guess it. */
const pairedTime = async (pairedAt: string, locale: string): Promise<string> => {
  const timeZone = (await settings.get<string>("app.timezone"))?.trim() || "UTC";
  return `${dates.formatDateTime(pairedAt, { locale, timeZone })} (${timeZone})`;
};
const phonePairedBody = async (
  data: { name: string; platform: PwaPlatform; pairedAt: string },
  locale: string,
  where: string,
): Promise<string> => text(locale).phonePairedBody({ ...data, time: await pairedTime(data.pairedAt, locale), where });

export const NOTIFICATIONS = {
  deviceEnrollment: notification({
    recipient: "user",
    label: "Sign-in device enrollment",
    description: "Security notice when a device is linked to approve Cloud sign-ins.",
    presentation: presentation("Anmeldegerät gekoppelt", "Sicherheitshinweis, wenn ein Gerät für Cloud-Anmeldungen gekoppelt wird."),
    delivery: requiredEmail,
    data: z.object({ name: z.string(), assisted: z.boolean() }),
    render: (data, { locale }) => ({ title: text(locale).deviceTitle, body: text(locale).deviceBody(data), targetHref: "/me/security" }),
    email: (data, { locale }) => ({ subject: text(locale).deviceTitle, content: text(locale).deviceBody(data) }),
  }),
  appDevicePaired: notification({
    recipient: "user",
    label: "Phones paired with the mobile app",
    description: "Security notice when a phone is paired with your account in the mobile app.",
    presentation: presentation(
      "Gekoppelte Telefone der Mobile App",
      "Sicherheitshinweis, wenn ein Telefon in der Mobile App mit deinem Konto gekoppelt wird.",
    ),
    // A personal preference: email first, a browser notification where email is not set up.
    delivery: { recommended: ["email", "browser"] },
    data: z.object({
      name: z.string().min(1).max(80),
      platform: z.enum(["ios", "android", "other"]),
      pairedAt: z.string().datetime(),
    }),
    render: async (data, { locale }) => ({
      title: text(locale).phonePairedTitle,
      body: await phonePairedBody(data, locale, text(locale).phonePairedInApp),
      targetHref: "/me/app",
    }),
    email: async (data, { locale }) => ({
      subject: text(locale).phonePairedTitle,
      content: await phonePairedBody(data, locale, text(locale).phonePairedAt({ url: await absoluteUrl("/me/app") })),
    }),
  }),
  magicLink: notification({
    recipient: "email",
    label: "Email sign-in links",
    description: "Required to sign in to local and guest accounts by email.",
    presentation: presentation("Anmeldelinks per E-Mail", "Erforderlich für die Anmeldung an lokalen und Gastkonten per E-Mail."),
    delivery: requiredEmail,
    data: z.object({ token: z.string(), magicLink: z.string().url() }),
    render: (_, { locale }) => ({ title: text(locale).signInCode, body: text(locale).signInBody }),
    email: async ({ token, magicLink }, { locale }) => {
      const [appName, template] = await Promise.all([settings.get<string>("app.name"), settings.get<string>("mail.magic_link_login")]);
      return {
        subject: text(locale).signInSubject({ appName }),
        rawHtml: renderTemplate(template, { TOKEN: token, MAGIC_LINK: magicLink, APP_NAME: appName }),
      };
    },
  }),
  ipaLoginHint: notification({
    recipient: "email",
    label: "FreeIPA sign-in guidance",
    description: "Required account guidance when email sign-in is requested for a FreeIPA account.",
    presentation: presentation(
      "Anmeldehinweise für FreeIPA",
      "Erforderliche Hinweise, wenn für ein FreeIPA-Konto eine Anmeldung per E-Mail angefordert wird.",
    ),
    delivery: requiredEmail,
    data: z.object({ email: z.string().email(), loginUrl: z.string().url() }),
    render: (_, { locale }) => ({ title: text(locale).ipaSignIn, body: text(locale).ipaSignInBody }),
    email: async ({ email, loginUrl }, { locale }) => {
      const [appName, contactEmail, template] = await Promise.all([
        settings.get<string>("app.name"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("mail.ipa_email_login_hint"),
      ]);
      return {
        subject: text(locale).ipaSignInSubject({ appName }),
        rawHtml: renderTemplate(template, {
          EMAIL: email,
          LOGIN_URL: loginUrl,
          APP_NAME: appName,
          CONTACT_EMAIL: contactEmail?.trim() ?? "",
        }),
      };
    },
  }),
  passwordReset: notification({
    recipient: "email",
    label: "Password resets",
    description: "Required to recover a FreeIPA-backed account.",
    presentation: presentation("Passwort zurücksetzen", "Erforderlich, um den Zugang zu einem FreeIPA-Konto wiederherzustellen."),
    delivery: requiredEmail,
    data: z.object({ resetLink: z.string().url() }),
    render: (_, { locale }) => ({ title: text(locale).passwordReset, body: text(locale).passwordResetBody }),
    email: async ({ resetLink }, { locale }) => {
      const [appName, contactEmail, template] = await Promise.all([
        settings.get<string>("app.name"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("mail.password_reset"),
      ]);
      return {
        subject: text(locale).passwordResetSubject({ appName }),
        rawHtml: renderTemplate(template, {
          RESET_LINK: resetLink,
          APP_NAME: appName,
          CONTACT_EMAIL: contactEmail?.trim() ?? "",
        }),
      };
    },
  }),
  accountExpiryReminder: notification({
    recipient: "user",
    label: "Account expiry reminders",
    description: "Required notice before an account expires and access is removed.",
    presentation: presentation("Erinnerungen an den Kontoablauf", "Erforderlicher Hinweis, bevor ein Konto abläuft und der Zugriff endet."),
    delivery: requiredEmail,
    data: z.object({
      firstName: z.string(),
      displayName: z.string(),
      expiresAt: z.string().datetime(),
      accountKind: z.enum(["ipa", "local-user", "local-guest"]),
    }),
    render: ({ expiresAt }, { locale }) => ({
      title: text(locale).expiryTitle,
      body: text(locale).expiryBody({ date: dates.formatDate(expiresAt, { locale }) }),
      targetHref: "/auth/extend",
    }),
    email: async ({ firstName, displayName, expiresAt, accountKind }, { locale }) => {
      const [appName, contactEmail, template, extendUrl] = await Promise.all([
        settings.get<string>("app.name"),
        settings.get<string>("app.contact_email"),
        settings.get<string>("mail.account_expiry_reminder"),
        accountExtensionUrl(),
      ]);
      return {
        subject: text(locale).expirySubject({ appName: appName || "Cloud" }),
        rawHtml: renderTemplate(template, {
          FIRST_NAME: firstName,
          DISPLAY_NAME: displayName,
          EXPIRY: dates.formatDate(expiresAt, { locale }),
          EXTEND_URL: extendUrl,
          APP_NAME: appName || "Cloud",
          CONTACT_EMAIL: contactEmail || "",
          ACCOUNT_KIND: accountKind,
        }),
      };
    },
  }),
};

type CoreNotificationDescriptors = BoundNotificationMap<"core", typeof NOTIFICATIONS>;

const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex");

export type CoreNotificationSender = AuthNotificationSender &
  AccountLifecycleNotificationSender & {
    sendDeviceEnrollment: (notice: AppDeviceEnrollmentNotice) => Promise<unknown>;
    sendAppDevicePaired: (notice: PwaDevicePairedNotice) => Promise<unknown>;
  };

export const createCoreNotificationSender = (definitions: CoreNotificationDescriptors): CoreNotificationSender => ({
  sendDeviceEnrollment: async ({ deviceId, userId, name, assisted }) =>
    notifications.send(definitions.deviceEnrollment, {
      recipient: { userId },
      data: { name, assisted },
      idempotencyKey: `device-enrollment:${deviceId}`,
      locale: await configuredLocale(),
    }),
  sendAppDevicePaired: async ({ deviceId, userId, name, platform, pairedAt, locale }) => {
    const result = await notifications.send(definitions.appDevicePaired, {
      recipient: { userId },
      data: { name, platform, pairedAt },
      idempotencyKey: `pwa-device-paired:${deviceId}`,
      locale: await configuredLocale(locale ?? undefined),
    });
    // Nothing went out because preparing a delivery failed: the phone stays pending, and the next
    // send with this key prepares again. A notice the person turned off, or one without a
    // destination, is done.
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("The new-phone notice could not be prepared");
    return result;
  },
  sendMagicLink: async ({ email, token, magicLink, locale }) =>
    notifications.send(definitions.magicLink, {
      recipient: { email },
      data: { token, magicLink },
      idempotencyKey: `magic-link:${fingerprint(token)}`,
      locale: await configuredLocale(locale),
    }),
  sendIpaLoginHint: async ({ email, loginUrl, locale }) =>
    notifications.send(definitions.ipaLoginHint, {
      recipient: { email },
      data: { email, loginUrl },
      idempotencyKey: `ipa-login-hint:${fingerprint(loginUrl)}`,
      locale: await configuredLocale(locale),
    }),
  sendPasswordReset: async ({ email, resetLink, locale }) =>
    notifications.send(definitions.passwordReset, {
      recipient: { email },
      data: { resetLink },
      idempotencyKey: `password-reset:${fingerprint(resetLink)}`,
      locale: await configuredLocale(locale),
    }),
  sendExpiryReminder: async ({ reminderId, userId, firstName, displayName, expiresAt, accountKind, locale }) =>
    notifications.send(definitions.accountExpiryReminder, {
      recipient: { userId },
      data: { firstName, displayName, expiresAt, accountKind },
      idempotencyKey: `account-expiry:${reminderId}`,
      locale: await configuredLocale(locale),
    }),
});
