import { splitQuotedHistory } from "./compose-renderer";

/** Revision-1 marked segments came from creation, regardless of the signature template's later state. */
export const hasLegacyReplyBodyEvidence = (body: string): boolean =>
  splitQuotedHistory(body.replace(/\n*\u2063[^\u2063\u2064]*\u2064\n*/g, "\n").replace(/[\u2063\u2064]/g, "")).reply.trim().length > 0;
