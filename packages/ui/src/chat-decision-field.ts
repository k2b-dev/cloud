/**
 * A separate entry for code that loads a question with a field on demand. Imported from here, it stays out of an
 * island's first JavaScript, because the main entry no longer has to keep it.
 */
export { ChatDecisionField, type ChatDecisionFieldProps } from "./chat/ChatDecisionField";
