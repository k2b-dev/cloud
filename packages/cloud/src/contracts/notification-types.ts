import type { output, ZodType } from "zod";
import { canonicalLocale, localeFallbackChain } from "../shared/locale";

export type NotificationRecipientKind = "user" | "email";

/** Deployment channel packages extend this registry through module augmentation. */
export interface NotificationChannelRegistry {
  email: true;
  browser: true;
}

export type NotificationChannelId = Extract<keyof NotificationChannelRegistry, string>;

const NOTIFICATION_TARGET_ORIGIN = "https://cloud.invalid";

export const isSafeNotificationTargetHref = (value: string): value is `/${string}` => {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const target = new URL(value, NOTIFICATION_TARGET_ORIGIN);
    return target.origin === NOTIFICATION_TARGET_ORIGIN && `${target.pathname}${target.search}${target.hash}` === value;
  } catch {
    return false;
  }
};

export const validateNotificationTargetHref = (value: string): `/${string}` => {
  if (!isSafeNotificationTargetHref(value)) throw new Error("Notification targetHref must be a canonical same-origin absolute path");
  return value;
};

export type NotificationPresentation = {
  title: string;
  body?: string;
  /** Same-origin absolute path. Validated again before persistence and navigation. */
  targetHref?: `/${string}`;
};

export type EmailNotificationPresentation = {
  subject: string;
  content?: string;
  rawHtml?: string;
};

export type NotificationRenderContext = {
  /** Canonical locale selected by the sender for this rendered notification. */
  locale: string;
};

export type NotificationDeliveryPolicy = {
  recommended?: readonly NotificationChannelId[];
  required?: readonly NotificationChannelId[];
};

export type NotificationDefinitionPresentationTranslation = {
  label?: string;
  description?: string;
};

export type NotificationDefinitionPresentationCatalog = {
  /** Locale of the complete `label` and `description` declaration. */
  baseLocale: string;
  /** Partial presentation overlays with exact -> ancestor -> base fallback. */
  translations: Readonly<Record<string, NotificationDefinitionPresentationTranslation>>;
};

export type NotificationDefinitionInput<R extends NotificationRecipientKind, S extends ZodType> = {
  recipient: R;
  label: string;
  description: string;
  presentation?: NotificationDefinitionPresentationCatalog;
  data: S;
  delivery?: NotificationDeliveryPolicy;
  render: (data: output<S>, context: NotificationRenderContext) => NotificationPresentation | Promise<NotificationPresentation>;
  email?: (data: output<S>, context: NotificationRenderContext) => EmailNotificationPresentation | Promise<EmailNotificationPresentation>;
};

const notificationDefinitionMarker = Symbol("cloud.notification-definition");

export type NotificationDefinition<R extends NotificationRecipientKind = NotificationRecipientKind, S extends ZodType = ZodType> = Readonly<
  NotificationDefinitionInput<R, S> & {
    readonly [notificationDefinitionMarker]: true;
  }
>;

type AnyNotificationDefinition = Readonly<{
  recipient: NotificationRecipientKind;
  label: string;
  description: string;
  presentation?: NotificationDefinitionPresentationCatalog;
  data: ZodType;
  delivery?: NotificationDeliveryPolicy;
  render: (...args: never[]) => NotificationPresentation | Promise<NotificationPresentation>;
  email?: (...args: never[]) => EmailNotificationPresentation | Promise<EmailNotificationPresentation>;
  readonly [notificationDefinitionMarker]: true;
}>;

export type NotificationDefinitionMap = Record<string, AnyNotificationDefinition>;

export type BoundNotificationDefinition<
  AppId extends string = string,
  Key extends string = string,
  R extends NotificationRecipientKind = NotificationRecipientKind,
  S extends ZodType = ZodType,
> = NotificationDefinition<R, S> & {
  readonly appId: AppId;
  readonly key: Key;
  readonly id: `${AppId}.${Key}`;
};

export type AnyBoundNotificationDefinition = AnyNotificationDefinition & {
  readonly appId: string;
  readonly key: string;
  readonly id: `${string}.${string}`;
};

export type BoundNotificationMap<AppId extends string, N extends NotificationDefinitionMap> = {
  readonly [K in keyof N]: N[K] extends NotificationDefinition<infer R, infer S>
    ? BoundNotificationDefinition<AppId, Extract<K, string>, R, S>
    : never;
};

export type NotificationRecipient<R extends NotificationRecipientKind> = R extends "user" ? { userId: string } : { email: string };

export type NotificationSendInput<D extends AnyBoundNotificationDefinition> =
  D extends BoundNotificationDefinition<string, string, infer R, infer S>
    ? {
        recipient: NotificationRecipient<R>;
        data: output<S>;
        idempotencyKey: string;
        sentBy?: string;
        /** Locale for final human-facing notification and email content. */
        locale?: string;
      }
    : never;

const hasDuplicates = (values: readonly string[]): boolean => new Set(values).size !== values.length;

const requiredPresentationText = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Notification presentation ${field} is required`);
  return normalized;
};

const compileDefinitionPresentation = (
  catalog: NotificationDefinitionPresentationCatalog | undefined,
): NotificationDefinitionPresentationCatalog | undefined => {
  if (!catalog) return undefined;
  const baseLocale = canonicalLocale(catalog.baseLocale);
  if (!baseLocale) throw new Error("Notification presentation baseLocale must be a valid BCP 47 locale");

  const translations: Record<string, NotificationDefinitionPresentationTranslation> = {};
  for (const [locale, translation] of Object.entries(catalog.translations)) {
    const canonical = canonicalLocale(locale);
    if (!canonical) throw new Error(`Notification presentation locale ${JSON.stringify(locale)} is not a valid BCP 47 locale`);
    if (canonical === baseLocale) throw new Error(`Notification presentation translations must not repeat base locale ${baseLocale}`);
    if (translations[canonical]) throw new Error(`Notification presentation locale ${canonical} is duplicated after canonicalization`);
    translations[canonical] = Object.freeze({
      ...(translation.label !== undefined ? { label: requiredPresentationText(translation.label, `${canonical}.label`) } : {}),
      ...(translation.description !== undefined
        ? { description: requiredPresentationText(translation.description, `${canonical}.description`) }
        : {}),
    });
  }
  return Object.freeze({ baseLocale, translations: Object.freeze(translations) });
};

export const resolveNotificationDefinitionPresentation = (
  definition: {
    label: string;
    description: string;
    presentation?: NotificationDefinitionPresentationCatalog | null;
  },
  requestedLocale?: string | null,
): { label: string; description: string } => {
  const catalog = definition.presentation;
  if (!catalog || !requestedLocale) return { label: definition.label, description: definition.description };
  const translations = new Map(Object.entries(catalog.translations));
  return localeFallbackChain(requestedLocale, catalog.baseLocale)
    .filter((locale) => locale !== catalog.baseLocale)
    .reverse()
    .reduce((resolved, locale) => ({ ...resolved, ...translations.get(locale) }), {
      label: definition.label,
      description: definition.description,
    });
};

export const notification = <const R extends NotificationRecipientKind, const S extends ZodType>(
  input: NotificationDefinitionInput<R, S>,
): NotificationDefinition<R, S> => {
  const label = input.label.trim();
  const description = input.description.trim();
  if (!label) throw new Error("Notification label is required");
  if (!description) throw new Error(`Notification "${label}" description is required`);

  const recommended = [...(input.delivery?.recommended ?? [])];
  const required = [...(input.delivery?.required ?? [])];
  if (hasDuplicates(recommended) || hasDuplicates(required)) {
    throw new Error(`Notification "${label}" contains duplicate delivery channels`);
  }
  const overlappingChannel = recommended.find((channel) => required.includes(channel));
  if (overlappingChannel) {
    throw new Error(`Notification "${label}" cannot recommend and require the "${overlappingChannel}" channel`);
  }
  if (input.recipient === "email" && !required.includes("email")) {
    throw new Error(`Email-recipient notification "${label}" must require the email channel`);
  }
  const presentation = compileDefinitionPresentation(input.presentation);

  const definition: NotificationDefinition<R, S> = {
    ...input,
    label,
    description,
    ...(presentation ? { presentation } : {}),
    delivery: Object.freeze({ recommended: Object.freeze(recommended), required: Object.freeze(required) }),
    [notificationDefinitionMarker]: true,
  };
  return Object.freeze(definition);
};

export const bindNotificationDefinitions = <const AppId extends string, const N extends NotificationDefinitionMap>(
  appId: AppId,
  definitions?: N,
): BoundNotificationMap<AppId, N> => {
  const result: Record<string, AnyBoundNotificationDefinition> = {};
  for (const [key, definition] of Object.entries(definitions ?? {})) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) {
      throw new Error(`Notification key "${key}" must be lower camelCase`);
    }
    result[key] = Object.freeze({ ...definition, appId, key, id: `${appId}.${key}` });
  }

  // Object iteration erases each heterogeneous definition's schema. The map
  // is rebuilt one-to-one without changing values, so callers safely retain N.
  return result as BoundNotificationMap<AppId, N>;
};
