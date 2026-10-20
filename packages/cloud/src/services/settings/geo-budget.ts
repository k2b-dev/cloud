import { HTTPException } from "hono/http-exception";
const MONTH = "geo.monthly_budget_credits";
const DAY = "geo.person_daily_credits";
export class GeoBudgetSettingError extends HTTPException {
  readonly code = "geo_budget_invalid";
  constructor() {
    const message = "Daily geo credits must not exceed the monthly geo budget";
    super(400, {
      message,
      res: Response.json({ code: "geo_budget_invalid", message, errors: { [DAY]: message, [MONTH]: message } }, { status: 400 }),
    });
  }
}
export const isGeoBudgetKey = (key: string) => key === MONTH || key === DAY;
/** Caller serializes both keys in the same transaction, including reset-to-default. */
export const validateGeoBudgetChange = async (key: string, value: unknown, read: (key: string) => Promise<unknown>) => {
  if (!isGeoBudgetKey(key)) return;
  const month = key === MONTH ? value : await read(MONTH);
  const day = key === DAY ? value : await read(DAY);
  if (typeof month !== "number" || typeof day !== "number" || day > month) throw new GeoBudgetSettingError();
};
