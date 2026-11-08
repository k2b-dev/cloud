export type WorkState = { status: "running" | "completed" | "cancelled" | "error"; completed: number; total?: number; label?: string };
