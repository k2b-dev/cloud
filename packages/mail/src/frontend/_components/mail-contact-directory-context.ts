import { createContext, useContext } from "solid-js";
import { DEFAULT_MAIL_CONTACT_DIRECTORY, type MailContactDirectory } from "../../contact-directory-settings";

/**
 * The resolved contact-directory mapping for Mail islands. SSR pages resolve it
 * from the request settings and each island root provides it; components never
 * name a provider app themselves.
 */
const MailContactDirectoryContext = createContext<MailContactDirectory>(DEFAULT_MAIL_CONTACT_DIRECTORY);

export const MailContactDirectoryProvider = MailContactDirectoryContext.Provider;
export const useMailContactDirectory = (): MailContactDirectory => useContext(MailContactDirectoryContext);
