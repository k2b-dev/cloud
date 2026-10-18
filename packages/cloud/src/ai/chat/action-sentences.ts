import { createContext, useContext } from "solid-js";

const ReaderTimeZoneContext = createContext<string>();

/** Gives the chat the reader's time zone from the request, so server and browser render the same times. */
export const AiReaderTimeZoneProvider = ReaderTimeZoneContext.Provider;

/** Instants show in the provided time zone, else the browser's own; outside a browser they stay in UTC. */
export const useReaderTimeZone = (): string =>
  useContext(ReaderTimeZoneContext) ?? (typeof window === "undefined" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone);

export { toolOutcome, toolSubject, toolWording } from "../tool-wording";
