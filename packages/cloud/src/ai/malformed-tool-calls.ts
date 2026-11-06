/**
 * nessi stores a call the provider sent malformed as a `tool_call` with an ID of
 * this form and answers it with an error result (`reason: "malformed_tool_call"`).
 * The call never runs; Cloud's own repairs before nessi 1.0 used the same form.
 */
export const isMalformedToolCallId = (id: string): boolean => /^malformed_[0-9a-f]{24}$/.test(id);
