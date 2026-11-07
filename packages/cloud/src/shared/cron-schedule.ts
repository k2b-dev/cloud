const CRON_FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

const cronError = (field: (typeof CRON_FIELDS)[number], value: string): Error => new Error(`cron ${field.name} field is invalid: ${value}`);

const cronNumber = (value: string, field: (typeof CRON_FIELDS)[number]): number => {
  if (!/^\d+$/u.test(value)) throw cronError(field, value);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < field.min || number > field.max) throw cronError(field, value);
  return number;
};

type CronFieldValues = { any: boolean; values: Set<number> };

const normalizeCronValue = (value: number, field: (typeof CRON_FIELDS)[number]): number =>
  field.name === "day-of-week" && value === 7 ? 0 : value;

const validateCronItem = (item: string, field: (typeof CRON_FIELDS)[number]): number[] => {
  const stepParts = item.split("/");
  if (stepParts.length > 2) throw cronError(field, item);
  const [base = "", step] = stepParts;
  const rangeParts = base.split("-");
  if (rangeParts.length > 2) throw cronError(field, item);

  const stepNumber = step === undefined ? 1 : Number(step);
  if (step !== undefined && (!/^\d+$/u.test(step) || !Number.isSafeInteger(stepNumber) || stepNumber < 1)) {
    throw cronError(field, item);
  }

  let start: number = field.min;
  let end: number = field.max;
  if (base !== "*") {
    const [startText = "", endText] = rangeParts;
    start = cronNumber(startText, field);
    end = endText === undefined ? start : cronNumber(endText, field);
  }

  const normalizedStart = normalizeCronValue(start, field);
  const normalizedEnd = normalizeCronValue(end, field);
  const values: number[] = [];
  if (field.name === "day-of-week" && start !== end && normalizedStart > normalizedEnd) {
    for (let value = normalizedStart; value <= field.max; value += stepNumber) values.push(normalizeCronValue(value, field));
    for (let value = field.min; value <= normalizedEnd; value += stepNumber) values.push(normalizeCronValue(value, field));
    return values;
  }
  if (normalizedStart > normalizedEnd) throw cronError(field, item);
  for (let value = normalizedStart; value <= normalizedEnd; value += stepNumber) values.push(normalizeCronValue(value, field));
  return values;
};

const validateCronField = (value: string, field: (typeof CRON_FIELDS)[number]): CronFieldValues => {
  const items = value.split(",");
  if (items.some((item) => item.length === 0)) throw cronError(field, value);
  const values = new Set(items.flatMap((item) => validateCronItem(item, field)));
  if (values.size === 0) throw cronError(field, value);
  return { any: value === "*", values };
};

const assertReachableCalendarDate = (fields: readonly CronFieldValues[]): void => {
  const dayOfMonth = fields[2]!;
  const month = fields[3]!;
  const dayOfWeek = fields[4]!;
  if (dayOfMonth.any || !dayOfWeek.any) return;
  const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const reachable = [...month.values].some((value) => [...dayOfMonth.values].some((day) => day <= maxDays[value - 1]!));
  if (!reachable) throw new Error("cron has no reachable calendar date");
};

export type CronSchedule = {
  cron: string;
  timezone: string;
};

export const normalizeCronSchedule = (schedule: CronSchedule): CronSchedule => {
  const fields = schedule.cron.trim().split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => field.length === 0)) {
    throw new Error("cron must contain exactly five fields");
  }
  const parsedFields = fields.map((value, index) => validateCronField(value, CRON_FIELDS[index]!));
  assertReachableCalendarDate(parsedFields);

  const timezone = schedule.timezone.trim();
  if (!timezone) throw new Error("timezone must be an IANA timezone");
  let normalizedTimezone: string;
  try {
    normalizedTimezone = new Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`timezone must be an IANA timezone: ${timezone}`);
  }
  return { cron: fields.join(" "), timezone: normalizedTimezone };
};
