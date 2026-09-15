export const readApiError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Preserve the operation-specific fallback for non-JSON failures.
  }
  return fallback;
};
