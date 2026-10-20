import { HTTPException } from "hono/http-exception";

export class SettingUnreadableError extends HTTPException {
  readonly code = "setting_unreadable" as const;

  constructor(readonly key: string) {
    const message = `The stored value of setting "${key}" cannot be read by this application. Replace it with a new value or reset it to the default.`;
    super(409, { message, res: Response.json({ code: "setting_unreadable", message }, { status: 409 }) });
    this.name = "SettingUnreadableError";
  }
}
