export const readErrorMessage = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const data = await response.json().catch(() => null);
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message;
  return fallback;
};
