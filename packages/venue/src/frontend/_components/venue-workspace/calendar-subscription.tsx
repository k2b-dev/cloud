import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, CopyButton, InlineGuidance, PanelDialog, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "../../../api/client";
import { venueMessages } from "../../../messages";
import { readError } from "./utils";

/** A `webcal://` link asks the device's calendar app to subscribe to the feed instead of downloading it once. */
export const webcalUrl = (url: string): string => url.replace(/^https?:\/\//, "webcal://");
