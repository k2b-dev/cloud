import { createBillingTemplate } from "./billing";
import { bookshopTemplate, createBookshopTemplate } from "./bookshop";
import { createFinanceTemplate, financeTemplate } from "./finance";
import { createInventoryTemplate, inventoryTemplate } from "./inventory";
import type { GridTemplate } from "./types";

export type {
  GridTemplate,
  TemplateDateExpression,
  TemplateRef,
} from "./types";

export const templates: GridTemplate[] = [bookshopTemplate, financeTemplate, inventoryTemplate, createBillingTemplate("en")];

export const getTemplates = (locale?: string): GridTemplate[] => [
  createBookshopTemplate(locale),
  createFinanceTemplate(locale),
  createInventoryTemplate(locale),
  createBillingTemplate(locale),
];

export const getTemplate = (id: string, locale?: string): GridTemplate | null =>
  getTemplates(locale).find((template) => template.id === id) ?? null;
