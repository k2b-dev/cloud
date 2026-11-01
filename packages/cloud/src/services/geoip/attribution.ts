/** DB-IP uploads can identify their provider in either metadata field. */
export const isDbIp = (value: string): boolean => /db[\s-]?ip/i.test(value);
