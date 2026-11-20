// The largest message literal ImapFlow will accept from a server. Anything
// bigger cannot be fetched at all, so it is also the hydration ceiling.
export const MAX_IMAP_LITERAL_BYTES = 128 * 1024 * 1024;
