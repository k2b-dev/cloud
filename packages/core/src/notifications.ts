import { createHash } from "node:crypto";
import { type BoundNotificationMap, type NotificationDeliveryPolicy, notification } from "@k2b/cloud";
import { codeOwnPath } from "@k2b/cloud/code";
import { validateNotificationTargetHref } from "@k2b/cloud/contracts";
import { APP_LOGIN_CONTEXT_BROWSERS, APP_LOGIN_CONTEXT_OSES } from "@k2b/cloud/contracts/app-approval";
import {
  type AppDeviceEnrollmentNotice,
  notifications,
  type PwaDevicePairedNotice,
  renderTemplate,
  SIGN_IN_METHODS,
  type SignInMethod,
} from "@k2b/cloud/services";
import type { AccountLifecycleNotificationSender } from "@k2b/cloud/services/account-lifecycle/notification-sender";
import type { AuthNotificationSender } from "@k2b/cloud/services/auth-flows";
import * as settings from "@k2b/cloud/services/settings";
import { dates, i18n } from "@k2b/stdlib";
import { z } from "zod";
import { type CodePageReportReason, CodePageReportReasonSchema } from "./code/page-provenance-contracts";

const requiredEmail: NotificationDeliveryPolicy = { required: ["email"] };
type PwaPlatform = PwaDevicePairedNotice["platform"];
const platformLabel = (platform: PwaPlatform, other: string) => (platform === "ios" ? "iOS" : platform === "android" ? "Android" : other);
const presentation = (label: string, description: string) => ({ baseLocale: "en", translations: { de: { label, description } } });

const notificationMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      codePageReportedTitle: ({ name }: { name: string | null }) => (name ? `${name} reported a page` : "Someone reported a page"),
      codePageReportedBody: ({ title, path, reason }: { title: string; path: string; reason: string | null }) =>
        [`“${title}”`, path, reason].filter(Boolean).join(" · "),
      codePageReportedEmail: ({ page, admin }: { page: string; admin: string }) => `Page: ${page}\nAutomation in Administration: ${admin}`,
      codePageReportResolvedTitle: "Your report was handled",
      codePageReportResolvedBody: "The admins of this Cloud have handled your report on this page.",
      reportReason: ({ reason }: { reason: CodePageReportReason }) =>
        ({
          security: "Security problem",
          suspicious: "Suspicious activity",
          false_information: "False information",
          illegal: "Illegal content",
          other: "Other",
        })[reason],
      codeDatabaseExpiryTitle: "Unused Code database",
      codeDatabaseExpiryBody: ({ title, date }: { title: string; date: string }) =>
        `The database of “${title}” will be deleted on ${date}. You can export it from the Code page first.`,
      newBrowserTitle: "New sign-in from a new browser",
      unknownBrowser: "Unknown browser",
      unknownSystem: "an unknown system",
      macOrIpad: "macOS or iPadOS",
      browserLine: ({ browser, os }: { browser: string; os: string }) => `${browser} on ${os}`,
      approximatePlace: ({ place }: { place: string }) => `Approximately ${place}`,
      greeting: ({ firstName }: { firstName: string | null }) => (firstName ? `Hi ${firstName},` : "Hi,"),
      newBrowserIntro: "Your account was just signed in from a browser Cloud did not know yet.",
      browserLabel: "Browser",
      locationLabel: "Location",
      timeLabel: "Time",
      methodLabel: "Sign-in method",
      passwordMethod: "Password",
      passkeyMethod: "Passkey",
      emailCodeMethod: "Email code",
      cloudLoginMethod: ({ device }: { device: string | null }) => (device ? `Cloud Login, approved on “${device}”` : "Cloud Login"),
      passwordResetMethod: "Password reset",
      expiredPasswordMethod: "Expired password changed",
      adminTokenMethod: "Emergency admin access",
      wasThisYou: "Was this you? Then you don't need to do anything.",
      newBrowserAction:
        "If this wasn't you, check your paired devices under <strong>Account\u00a0› Sign-in</strong> and contact your administrator.",
      openSignIn: "Open sign-in",
      newBrowserFooter: "You get this notice once per new browser. You can turn it off under Account\u00a0› Notifications.",
      approximateFooter: " Locations are approximate.",
      deviceTitle: "New sign-in device linked",
      deviceBody: ({ name, assisted }: { name: string; assisted: boolean }) =>
        `The device “${name}” can now approve Cloud sign-ins.${assisted ? " An administrator helped link it." : ""} If this was not you, contact your administrator and revoke the device.`,
      accessCommandTitle: "New access for the command line",
      accessAppTitle: ({ app }: { app: string }) => `${app} has access to your account`,
      accessBody: ({ time }: { time: string }) => `New access was confirmed on ${time}. If this was not you, contact your administrator.`,
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
      phonePairedTitle: "New device paired",
      phonePairedBody: ({ name, platform, time, where }: { name: string; platform: PwaPlatform; time: string; where: string }) =>
        `The device “${name}” (${platformLabel(platform, "other platform")}) was paired with your account in the Cloud app on ${time}. If this wasn't you, remove it ${where} and contact your administrator.`,
      phonePairedBy: ({ name }: { name: string }) => `Set up by ${name} (Administration).`,
      phonePairedInApp: "under App in your profile menu",
      phonePairedAt: ({ url }: { url: string }) => `at ${url}`,
    },
    de: {
      codePageReportedTitle: ({ name }) => (name ? `${name} hat eine Seite gemeldet` : "Jemand hat eine Seite gemeldet"),
      codePageReportedBody: ({ title, path, reason }) => [`„${title}“`, path, reason].filter(Boolean).join(" · "),
      codePageReportedEmail: ({ page, admin }) => `Seite: ${page}\nAutomation in der Administration: ${admin}`,
      codePageReportResolvedTitle: "Deine Meldung ist erledigt",
      codePageReportResolvedBody: "Die Admins dieser Cloud haben deine Meldung zu dieser Seite bearbeitet.",
      reportReason: ({ reason }) =>
        ({
          security: "Sicherheitsproblem",
          suspicious: "Verdächtige Aktivität",
          false_information: "Falsche Angaben",
          illegal: "Rechtswidrige Inhalte",
          other: "Sonstiges",
        })[reason],
      codeDatabaseExpiryTitle: "Ungenutzte Code-Datenbank",
      codeDatabaseExpiryBody: ({ title, date }) =>
        `Die Datenbank von „${title}“ wird am ${date} gelöscht. Du kannst sie vorher auf der Code-Seite exportieren.`,
      newBrowserTitle: "Neue Anmeldung aus einem neuen Browser",
      unknownBrowser: "Unbekannter Browser",
      unknownSystem: "einem unbekannten System",
      macOrIpad: "macOS oder iPadOS",
      browserLine: ({ browser, os }) => `${browser} auf ${os}`,
      approximatePlace: ({ place }) => `Ungefähr ${place}`,
      greeting: ({ firstName }) => (firstName ? `Hallo ${firstName},` : "Hallo,"),
      newBrowserIntro: "dein Konto wurde gerade in einem Browser angemeldet, den Cloud noch nicht kannte.",
      browserLabel: "Browser",
      locationLabel: "Ort",
      timeLabel: "Zeit",
      methodLabel: "Anmeldeweg",
      passwordMethod: "Passwort",
      passkeyMethod: "Passkey",
      emailCodeMethod: "E-Mail-Code",
      cloudLoginMethod: ({ device }) => (device ? `Cloud Login, bestätigt auf „${device}“` : "Cloud Login"),
      passwordResetMethod: "Passwort zurückgesetzt",
      expiredPasswordMethod: "Abgelaufenes Passwort geändert",
      adminTokenMethod: "Admin-Notfallzugang",
      wasThisYou: "Warst du das? Dann musst du nichts tun.",
      newBrowserAction:
        "Falls du das nicht warst, prüfe unter <strong>Konto\u00a0› Anmeldung</strong> deine gekoppelten Geräte und wende dich an die Administration.",
      openSignIn: "Anmeldung öffnen",
      newBrowserFooter:
        "Diese Benachrichtigung kommt einmal pro neuem Browser. Du kannst sie unter Konto\u00a0› Benachrichtigungen abschalten.",
      approximateFooter: " Ortsangaben sind ungefähr.",
      deviceTitle: "Neues Anmeldegerät gekoppelt",
      deviceBody: ({ name, assisted }) =>
        `Das Gerät „${name}“ kann jetzt Cloud-Anmeldungen bestätigen.${assisted ? " Ein Administrator hat die Kopplung unterstützt." : ""} Falls du das nicht warst, kontaktiere deinen Administrator und widerrufe das Gerät.`,
      accessCommandTitle: "Neuer Zugang für die Kommandozeile",
      accessAppTitle: ({ app }) => `${app} hat Zugriff auf dein Konto`,
      accessBody: ({ time }) => `Neuer Zugang wurde am ${time} bestätigt. Falls du das nicht warst, wende dich an die Administration.`,
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
      phonePairedTitle: "Neues Gerät gekoppelt",
      phonePairedBody: ({ name, platform, time, where }) =>
        `Das Gerät „${name}“ (${platformLabel(platform, "andere Plattform")}) wurde am ${time} in der Cloud-App mit deinem Konto gekoppelt. Falls du das nicht warst, entferne es ${where} und wende dich an die Administration.`,
      phonePairedBy: ({ name }) => `Eingerichtet von ${name} (Administration).`,
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
  let baseUrl = configured.startsWith("http://") || configured.startsWith("https://") ? configured : `https://${configured}`;
  // A loop, because /\/+$/ backtracks polynomially on a value with many slashes inside.
  while (baseUrl.endsWith("/")) baseUrl = baseUrl.slice(0, -1);
  return `${baseUrl}${path}`;
};
const accountExtensionUrl = (): Promise<string> => absoluteUrl("/auth/extend");
/** The automation in Administration › Code, where admins resolve reports. */
const codeAdminHref = (codeId: string): `/${string}` => `/admin/code?sec=code&id=${encodeURIComponent(codeId)}`;

/** A notice's time in the installation's timezone, named so that nobody has to guess it. */
const installationTime = async (at: string, locale: string): Promise<string> => {
  const timeZone = (await settings.get<string>("app.timezone"))?.trim() || "UTC";
  return `${dates.formatDateTime(at, { locale, timeZone })} (${timeZone})`;
};
const phonePairedBody = async (
  data: { name: string; platform: PwaPlatform; pairedAt: string; pairedByName?: string },
  locale: string,
  where: string,
): Promise<string> => {
  const body = text(locale).phonePairedBody({ ...data, time: await installationTime(data.pairedAt, locale), where });
  return data.pairedByName ? `${body} ${text(locale).phonePairedBy({ name: data.pairedByName })}` : body;
};

const newBrowserData = z.object({
  browser: z.enum(APP_LOGIN_CONTEXT_BROWSERS),
  os: z.enum(APP_LOGIN_CONTEXT_OSES),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  city: z.string().max(96).nullable(),
  signedInAt: z.string().datetime(),
  method: z.enum(SIGN_IN_METHODS),
  device: z.string().min(1).max(80).nullable(),
  firstName: z.string().max(200).nullable(),
});
type NewBrowserData = z.infer<typeof newBrowserData>;
const browserLine = (data: NewBrowserData, locale: string): string => {
  const t = text(locale);
  const browsers = {
    firefox: "Firefox",
    chrome: "Chrome",
    safari: "Safari",
    edge: "Edge",
    samsung: "Samsung Internet",
    opera: "Opera",
    other: t.unknownBrowser,
  };
  const systems = {
    windows: "Windows",
    macos: "macOS",
    "mac-or-ipad": t.macOrIpad,
    ios: "iOS",
    android: "Android",
    linux: "Linux",
    chromeos: "ChromeOS",
    other: t.unknownSystem,
  };
  return t.browserLine({ browser: browsers[data.browser], os: systems[data.os] });
};
const signInMethod = (method: SignInMethod, device: string | null, locale: string): string => {
  const t = text(locale);
  const methods = {
    password: t.passwordMethod,
    passkey: t.passkeyMethod,
    email_code: t.emailCodeMethod,
    cloud_login: t.cloudLoginMethod({ device }),
    password_reset: t.passwordResetMethod,
    expired_password: t.expiredPasswordMethod,
    admin_token: t.adminTokenMethod,
  };
  return methods[method];
};
const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const newBrowserEmail = async (data: NewBrowserData, locale: string) => {
  const t = text(locale);
  const rows: [string, string][] = [[t.browserLabel, browserLine(data, locale)]];
  if (data.country) {
    const country = new Intl.DisplayNames([locale], { type: "region" }).of(data.country) || data.country;
    rows.push([t.locationLabel, t.approximatePlace({ place: data.city ? `${data.city}, ${country}` : country })]);
  }
  rows.push(
    [t.timeLabel, await installationTime(data.signedInAt, locale)],
    [t.methodLabel, signInMethod(data.method, data.device, locale)],
  );
  const details = rows
    .map(
      ([label, value]) =>
        `<tr><td style="color:#71717a;padding:4px 16px 4px 0;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td><td style="color:#18181b;font-weight:600;padding:4px 0;vertical-align:top">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const greeting = t.greeting({ firstName: data.firstName });
  const signInUrl = await absoluteUrl("/me/security");
  const footer = t.newBrowserFooter + (data.country ? t.approximateFooter : "");
  return {
    subject: t.newBrowserTitle,
    // The plain-text part keeps one line per detail; the frame would otherwise flatten the table into one line.
    content: [
      greeting,
      t.newBrowserIntro,
      rows.map(([label, value]) => `${label}: ${value}`).join("\n"),
      t.wasThisYou,
      t.newBrowserAction.replace(/<\/?strong>/g, ""),
      `${t.openSignIn}: ${signInUrl}`,
      footer,
    ].join("\n\n"),
    rawHtml: `<p style="margin-top:0">${escapeHtml(greeting)}</p>
<p>${escapeHtml(t.newBrowserIntro)}</p>
<div style="background:#f4f4f5;border-radius:10px;padding:12px 16px"><table style="border:0;width:100%" cellpadding="0" cellspacing="0">${details}</table></div>
<p>${escapeHtml(t.wasThisYou)}</p>
<p>${t.newBrowserAction}</p>
<p><a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;padding:10px 18px;border-radius:8px;font-weight:600;text-decoration:none">${escapeHtml(t.openSignIn)}</a></p>
<p style="font-size:12px;color:#71717a;margin-bottom:0">${escapeHtml(footer)}</p>`,
  };
};

export type OAuthNewAccessNotice = {
  familyId: string;
  userId: string;
  kind: "command_line" | "app";
  clientName: string;
  createdAt: string;
};

const accessTitle = (data: { kind: "command_line" | "app"; clientName: string }, locale: string) =>
  data.kind === "command_line" ? text(locale).accessCommandTitle : text(locale).accessAppTitle({ app: data.clientName });

export const NOTIFICATIONS = {
  codeReview: notification({
    recipient: "user",
    label: "Code version reviews",
    description: "Pending Code reviews and decisions on versions you manage.",
    delivery: { recommended: ["browser"] },
    presentation: presentation("Prüfung einer Code-Version", "Offene Prüfungen und Entscheidungen zu deinen Automationen."),
    data: z.object({
      codeId: z.string(),
      title: z.string(),
      versionId: z.uuid(),
      number: z.number().int().positive(),
      kind: z.enum(["submitted", "decided"]),
      outcome: z.enum(["approved", "changes_requested", "rejected"]).nullable(),
      by: z.string().nullable(),
      targetHref: z.templateLiteral(["/", z.string()]).optional(),
      waiting: z.object({ short: z.string(), href: z.templateLiteral(["/", z.string()]) }).optional(),
      automaticRevision: z.boolean().optional(),
    }),
    render: (data, { locale }) => {
      const de = locale.startsWith("de");
      const by = data.by ?? (de ? "Ein Admin" : "An admin");
      return {
        title:
          data.kind === "submitted"
            ? de
              ? `Version ${data.number} wartet auf Admin-Freigabe`
              : `Version ${data.number} is waiting for admin approval`
            : data.outcome === "changes_requested"
              ? de
                ? `${by} hat Änderungen an Version ${data.number} angefordert`
                : `${by} requested changes to version ${data.number}`
              : data.outcome === "approved"
                ? de
                  ? `${by} hat Version ${data.number} freigegeben`
                  : `${by} approved version ${data.number}`
                : de
                  ? `${by} hat Version ${data.number} abgelehnt`
                  : `${by} rejected version ${data.number}`,
        body: [
          data.title,
          data.waiting?.short,
          data.automaticRevision ? (de ? "Gustav überarbeitet die Version." : "Gustav is revising the version.") : null,
        ]
          .filter(Boolean)
          .join(" · "),
        targetHref:
          data.kind === "submitted"
            ? `/admin/code?sec=approvals&id=${data.versionId}`
            : (data.waiting?.href ?? data.targetHref ?? `/app/assistant/code/${data.codeId}?tab=versions&version=${data.versionId}`),
      };
    },
  }),
  codePageReported: notification({
    recipient: "user",
    label: "Reported Code pages",
    description: "For administrators: a member reported a page that an automation serves.",
    delivery: { recommended: ["email", "browser"] },
    presentation: presentation(
      "Gemeldete Code-Seiten",
      "Für Admins: Ein Mitglied hat eine Seite gemeldet, die eine Automation ausliefert.",
    ),
    data: z.object({
      codeId: z.string(),
      title: z.string(),
      path: z.string().startsWith("/"),
      reason: CodePageReportReasonSchema.nullable(),
      by: z.string().nullable(),
    }),
    render: (data, { locale }) => ({
      title: text(locale).codePageReportedTitle({ name: data.by }),
      body: text(locale).codePageReportedBody({
        title: data.title,
        path: data.path,
        reason: data.reason ? text(locale).reportReason({ reason: data.reason }) : null,
      }),
      targetHref: codeAdminHref(data.codeId),
    }),
    email: async (data, { locale }) => ({
      subject: text(locale).codePageReportedTitle({ name: data.by }),
      content: `${text(locale).codePageReportedBody({
        title: data.title,
        path: data.path,
        reason: data.reason ? text(locale).reportReason({ reason: data.reason }) : null,
      })}\n\n${text(locale).codePageReportedEmail({
        page: await absoluteUrl(codeOwnPath(data.codeId, data.path)),
        admin: await absoluteUrl(codeAdminHref(data.codeId)),
      })}`,
    }),
  }),
  codePageReportResolved: notification({
    recipient: "user",
    label: "Your page reports",
    description: "Notice when an administrator has handled a page you reported.",
    delivery: { recommended: ["browser"] },
    presentation: presentation("Deine Meldungen zu Seiten", "Hinweis, wenn ein Admin eine Seite bearbeitet hat, die du gemeldet hast."),
    data: z.object({ codeId: z.string(), path: z.string().startsWith("/") }),
    render: (data, { locale }) => ({
      title: text(locale).codePageReportResolvedTitle,
      body: text(locale).codePageReportResolvedBody,
      targetHref: validateNotificationTargetHref(codeOwnPath(data.codeId, data.path)),
    }),
  }),
  oauthNewAccess: notification({
    recipient: "user",
    label: "New access",
    description: "Notice when a new application or command line access is confirmed.",
    presentation: presentation("Neuer Zugang", "Hinweis, wenn ein neuer Zugang für eine Anwendung oder die Kommandozeile bestätigt wird."),
    delivery: { recommended: ["email", "browser"] },
    data: z.object({ kind: z.enum(["command_line", "app"]), clientName: z.string(), createdAt: z.string().datetime() }),
    render: async (data, { locale }) => ({
      title: accessTitle(data, locale),
      body: text(locale).accessBody({ time: await installationTime(data.createdAt, locale) }),
      targetHref: "/me/security",
    }),
    email: async (data, { locale }) => ({
      subject: accessTitle(data, locale),
      content: `${text(locale).accessBody({ time: await installationTime(data.createdAt, locale) })} ${await absoluteUrl("/me/security")}`,
    }),
  }),
  newBrowserSignIn: notification({
    recipient: "user",
    label: "New sign-in from a new browser",
    description: "Once per new browser, after the sign-in.",
    presentation: presentation("Neue Anmeldung aus einem neuen Browser", "Einmal pro neuem Browser, nach der Anmeldung."),
    // A personal preference: email first, a browser notification where email is not set up.
    delivery: { recommended: ["email", "browser"] },
    data: newBrowserData,
    render: async (data, { locale }) => {
      // The browser channel shows only `preview` next to the title, also on the lock screen: no place here.
      const summary = `${browserLine(data, locale)} · ${await installationTime(data.signedInAt, locale)}`;
      return { title: text(locale).newBrowserTitle, body: summary, preview: summary, targetHref: "/me/security" };
    },
    email: (data, { locale }) => newBrowserEmail(data, locale),
  }),
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
    label: "Devices paired with the Cloud app",
    description: "Security notice when a device is paired with your account in the Cloud app.",
    presentation: presentation(
      "Gekoppelte Geräte der Cloud-App",
      "Sicherheitshinweis, wenn ein Gerät in der Cloud-App mit deinem Konto gekoppelt wird.",
    ),
    // A personal preference: email first, a browser notification where email is not set up.
    delivery: { recommended: ["email", "browser"] },
    data: z.object({
      name: z.string().min(1).max(80),
      platform: z.enum(["ios", "android", "other"]),
      pairedAt: z.string().datetime(),
      pairedByName: z.string().optional(),
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
  codeDatabaseExpiry: notification({
    recipient: "user",
    label: "Unused Code database deletion",
    delivery: { recommended: ["email", "browser"] },
    description: "Notice before an unused personal Code database is deleted.",
    presentation: presentation(
      "Löschung ungenutzter Code-Datenbanken",
      "Hinweis vor der Löschung einer ungenutzten persönlichen Code-Datenbank.",
    ),
    data: z.object({ codeId: z.string(), title: z.string(), deleteAt: z.iso.datetime() }),
    render: ({ codeId, title, deleteAt }, { locale }) => ({
      title: text(locale).codeDatabaseExpiryTitle,
      body: text(locale).codeDatabaseExpiryBody({ title, date: dates.formatDate(deleteAt, { locale }) }),
      targetHref: `/app/assistant/code/${codeId}`,
    }),
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
    sendCodeReview: (notice: {
      userId: string;
      codeId: string;
      title: string;
      versionId: string;
      number: number;
      kind: "submitted" | "decided";
      outcome: "approved" | "changes_requested" | "rejected" | null;
      by: string | null;
      locale: string;
      origin: import("./code/review-contracts").CodeSubmissionOrigin;
      targetHref?: `/${string}`;
      waiting?: { short: string; href: `/${string}` };
      automaticRevision?: boolean;
      key: string;
    }) => Promise<unknown>;
    sendCodeDatabaseExpiry: (notice: { userId: string; codeId: string; title: string; deleteAt: string; key: string }) => Promise<unknown>;
    /** To one admin about a report, or back to the person who reported once an admin resolved it. */
    sendCodePageReport: (
      notice: { userId: string; locale: string; key: string; codeId: string; path: string } & (
        | { kind: "reported"; title: string; reason: CodePageReportReason | null; by: string | null }
        | { kind: "resolved" }
      ),
    ) => Promise<unknown>;
    sendOAuthNewAccess: (notice: OAuthNewAccessNotice) => Promise<unknown>;
    sendDeviceEnrollment: (notice: AppDeviceEnrollmentNotice) => Promise<unknown>;
    sendAppDevicePaired: (notice: PwaDevicePairedNotice) => Promise<unknown>;
  };

export const createCoreNotificationSender = (definitions: CoreNotificationDescriptors): CoreNotificationSender => ({
  sendCodeReview: async ({ userId, locale, key, origin: _origin, ...data }) => {
    const result = await notifications.send(definitions.codeReview, { recipient: { userId }, data, locale, idempotencyKey: key });
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("Code review notice could not be prepared");
    return result;
  },
  sendCodePageReport: async (notice) => {
    const { userId, locale, key, codeId, path } = notice;
    const result =
      notice.kind === "reported"
        ? await notifications.send(definitions.codePageReported, {
            recipient: { userId },
            data: { codeId, path, title: notice.title, reason: notice.reason, by: notice.by },
            locale,
            idempotencyKey: key,
          })
        : await notifications.send(definitions.codePageReportResolved, {
            recipient: { userId },
            data: { codeId, path },
            locale,
            idempotencyKey: key,
          });
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("Code page report notice could not be prepared");
    return result;
  },
  sendCodeDatabaseExpiry: async ({ userId, codeId, title, deleteAt, key }) => {
    const result = await notifications.send(definitions.codeDatabaseExpiry, {
      recipient: { userId },
      data: { codeId, title, deleteAt },
      idempotencyKey: key,
      locale: await configuredLocale(),
    });
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("Code database notice could not be prepared");
    return result;
  },
  sendOAuthNewAccess: async ({ familyId, userId, kind, clientName, createdAt }) => {
    const result = await notifications.send(definitions.oauthNewAccess, {
      recipient: { userId },
      data: { kind, clientName, createdAt },
      idempotencyKey: `oauth-new-access:${familyId}`,
      locale: await configuredLocale(),
    });
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("The new-access notice could not be prepared");
    return result;
  },
  sendDeviceEnrollment: async ({ deviceId, userId, name, assisted }) =>
    notifications.send(definitions.deviceEnrollment, {
      recipient: { userId },
      data: { name, assisted },
      idempotencyKey: `device-enrollment:${deviceId}`,
      locale: await configuredLocale(),
    }),
  sendAppDevicePaired: async ({ deviceId, userId, name, platform, pairedAt, locale, pairedBy }) => {
    const result = await notifications.send(definitions.appDevicePaired, {
      recipient: { userId },
      data: { name, platform, pairedAt, ...(pairedBy ? { pairedByName: pairedBy.name } : {}) },
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
  sendNewBrowserSignIn: async ({ browserId, userId, browser, os, country, city, signedInAt, method, device, firstName, locale }) => {
    const result = await notifications.send(definitions.newBrowserSignIn, {
      recipient: { userId },
      data: { browser, os, country, city, signedInAt, method, device, firstName },
      idempotencyKey: `new-browser-sign-in:${browserId}:${signedInAt}`,
      locale: await configuredLocale(locale ?? undefined),
    });
    // A disabled notice is done; a failed preparation stays pending for maintenance.
    if (result.status === "suppressed" && result.deliveries.some((delivery) => delivery.errorCode === "preparation_failed"))
      throw new Error("The new-browser notice could not be prepared");
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
