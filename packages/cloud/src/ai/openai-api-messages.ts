import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      openai_api_disabled: "The OpenAI-compatible API is turned off. Contact an administrator.",
      invalid_api_key: "Use an active API key with the access “AI models only”. Create one in your Cloud profile.",
      model_not_found: "This model is unavailable or you do not have access to it.",
      invalid_request: "The request does not match the supported chat completion format.",
      unsupported_content:
        "Only text messages with system, developer, user or assistant roles are supported. Tool calls are not supported.",
      unsupported_parameter: "This parameter is not supported. This API gives access to the models only.",
      context_length_exceeded: "Your messages exceed this model's context window. Shorten them and try again.",
      request_too_large: "The request body exceeds the limit derived from your available models' context windows.",
      ai_disabled: "AI is turned off. Contact an administrator.",
      insufficient_quota:
        "Your Assistant usage limit is reached, or your usage could not be measured. Wait for the reset or contact an administrator.",
      too_many_concurrent_requests: "You have too many simultaneous requests. Wait for a request to finish and try again.",
      rate_limit_exceeded: "Too many requests. Wait and try again.",
      upstream_error: "The model provider could not complete your request. Try again later.",
      internal_error: "Cloud could not process your request. Try again later.",
      not_found: "This OpenAI-compatible API route does not exist.",
    },
    de: {
      openai_api_disabled: "Die OpenAI-kompatible API ist ausgeschaltet. Wende dich an einen Administrator.",
      invalid_api_key: "Verwende einen aktiven API-Schlüssel mit dem Zugriff „Nur KI-Modelle“. Du erstellst ihn in deinem Cloud-Profil.",
      model_not_found: "Dieses Modell ist nicht verfügbar oder nicht für dich freigegeben.",
      invalid_request: "Deine Anfrage entspricht nicht dem unterstützten Format für Chat-Vervollständigungen.",
      unsupported_content:
        "Nur Textnachrichten mit den Rollen system, developer, user oder assistant werden unterstützt. Werkzeugaufrufe werden nicht unterstützt.",
      unsupported_parameter: "Dieser Parameter wird nicht unterstützt. Diese API gibt nur Zugriff auf die Modelle.",
      context_length_exceeded: "Deine Nachrichten überschreiten das Kontextfenster dieses Modells. Kürze sie und versuche es erneut.",
      request_too_large: "Deine Anfrage überschreitet die aus den Kontextfenstern deiner verfügbaren Modelle abgeleitete Größenbegrenzung.",
      ai_disabled: "KI ist ausgeschaltet. Wende dich an einen Administrator.",
      insufficient_quota:
        "Dein Nutzungslimit im Assistenten ist erreicht, oder deine Nutzung konnte nicht gemessen werden. Warte auf das Zurücksetzen oder wende dich an einen Administrator.",
      too_many_concurrent_requests: "Du hast zu viele gleichzeitige Anfragen. Warte, bis eine Anfrage beendet ist, und versuche es erneut.",
      rate_limit_exceeded: "Zu viele Anfragen. Warte kurz und versuche es erneut.",
      upstream_error: "Der Modellanbieter konnte deine Anfrage nicht abschließen. Versuche es später erneut.",
      internal_error: "Cloud konnte deine Anfrage nicht verarbeiten. Versuche es später erneut.",
      not_found: "Diese Route der OpenAI-kompatiblen API existiert nicht.",
    },
  },
});

export type OpenAiErrorCode = keyof ReturnType<typeof catalog.resolve>["t"];
export const openAiApiMessages = (locale: string) => catalog.resolve([locale]).t;
export const checkOpenAiApiMessages = () => catalog.check();
