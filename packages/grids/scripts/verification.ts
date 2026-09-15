const localServices = {
  PostgreSQL: { protocols: ["postgres:", "postgresql:"], hosts: ["localhost", "127.0.0.1", "ipa_postgres"] },
  NATS: { protocols: ["nats:"], hosts: ["localhost", "127.0.0.1", "nats"] },
  Gotenberg: { protocols: ["http:"], hosts: ["localhost", "127.0.0.1", "gotenberg"] },
};

/** Reject remote targets without including credentials in diagnostics. */
export const localVerificationUrl = (service: keyof typeof localServices, value: string | undefined): URL => {
  const url = value ? URL.parse(value) : null;
  const allowed = localServices[service];
  if (!url || !allowed.protocols.includes(url.protocol) || !allowed.hosts.includes(url.hostname)) {
    throw new Error(`Grids verification requires local ${service}`);
  }
  return url;
};

export const assertVerificationReport = (xml: string, phase: string): void => {
  if (
    !/<testcase[\s/>]/.test(xml) ||
    /<(?:skipped|failure|error)[\s/>]/.test(xml) ||
    /\b(?:skipped|failures|errors)="[1-9]\d*"/.test(xml)
  ) {
    throw new Error(`${phase} ran no tests, skipped tests, or reported failures`);
  }
};
