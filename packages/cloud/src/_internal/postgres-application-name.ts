/** Preserve operator URL options; otherwise name every connection through native client options. */
export const postgresApplicationOptions = (applicationId: string, connectionUrl: string): Record<string, string> => {
  const url = new URL(connectionUrl);
  let operatorConfigured = false;
  url.searchParams.forEach((_value, key) => {
    if (key.toLowerCase() === "application_name" || key.toLowerCase() === "options") operatorConfigured = true;
  });
  return operatorConfigured ? {} : { application_name: `cloud:${applicationId}` };
};
