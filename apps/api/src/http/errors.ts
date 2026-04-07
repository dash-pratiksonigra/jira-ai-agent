import { z } from "zod";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export function parseJson<T>(raw: unknown, schema: z.ZodType<T>): T {
  const res = schema.safeParse(raw);
  if (!res.success) throw new HttpError(400, "Invalid request body", res.error.flatten());
  return res.data;
}

