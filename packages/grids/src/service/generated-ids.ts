import { crypto, type DateContext } from "@k2b/stdlib";
import { isUniqueViolation } from "@k2b/cloud/services";
import { fieldUniqueIndexName } from "./field-indexes";
import { allocateNumber } from "./number-series";
import type { Field } from "./types";

type IdStrategy = "sequence" | "date_sequence" | "short_code" | "random_code" | "uuid" | "uuidv7" | "ulid";

type IdConfig = {
  strategy?: IdStrategy;
  prefix?: string;
  padding?: number;
  period?: "year" | "month" | "day";
  length?: number;
  groups?: number;
  segmentLength?: number;
};

const prefixOf = (config: IdConfig): string => config.prefix ?? "";

export const generatedIdRequiresRetry = (field: Field): boolean => {
  if (field.type !== "id") return false;
  const strategy = ((field.config as IdConfig).strategy ?? "sequence") as IdStrategy;
  return strategy === "short_code" || strategy === "random_code" || strategy === "uuid" || strategy === "uuidv7" || strategy === "ulid";
};

export const isGeneratedIdUniqueCollision = (error: unknown, fields: Field[]): boolean =>
  fields.some((field) => generatedIdRequiresRetry(field) && isUniqueViolation(error, fieldUniqueIndexName(field.id)));

const randomCode = (config: IdConfig): string => {
  const groups = config.groups ?? 2;
  const segmentLength = config.segmentLength ?? 4;
  return crypto.common.readableId(...Array.from({ length: groups }, () => segmentLength));
};

export const generateIdValue = async (
  field: Field,
  options: {
    dateConfig?: DateContext;
    now?: Date;
    allocator?: typeof allocateNumber;
  } = {},
): Promise<string> => {
  const config = field.config as IdConfig;
  const strategy = config.strategy ?? "sequence";
  const prefix = prefixOf(config);
  const now = options.now ?? new Date();
  const allocator = options.allocator ?? allocateNumber;

  switch (strategy) {
    case "sequence": {
      return (
        await allocator({
          owner: { kind: "field", id: field.id },
          now,
          dateConfig: options.dateConfig,
        })
      ).renderedValue;
    }
    case "date_sequence": {
      return (
        await allocator({
          owner: { kind: "field", id: field.id },
          now,
          dateConfig: options.dateConfig,
        })
      ).renderedValue;
    }
    case "short_code":
      return `${prefix}${crypto.common.readableId(config.length ?? 5)}`;
    case "random_code":
      return `${prefix}${randomCode(config)}`;
    case "uuid":
      return `${prefix}${crypto.common.uuid()}`;
    case "uuidv7":
      return `${prefix}${Bun.randomUUIDv7()}`;
    case "ulid":
      return `${prefix}${crypto.common.ulid()}`;
  }
};
