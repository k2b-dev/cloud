/**
 * SSR targets at most 80 KiB of HTML for the 40-message phone fixture. The measured
 * baseline is 125,808 bytes: 35,777 for the list plus about 2,251 bytes per message
 * (markup and island props). Sixteen rows leave about 10 KiB for conversation UI
 * and variation: 35,777 + 16 * 2,251 = 71,793 bytes. Cursor pages stay at 50.
 * Unread pages start at their marker so this window can still align it at the
 * top of a desktop viewport; explicit message links remain centered.
 * This is a representative-fixture budget, not a cap on legitimate message text.
 */
export const INITIAL_MESSAGE_PAGE_SIZE = 16;
