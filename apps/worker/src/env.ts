import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  API_BASE_URL: z.string().url().default("http://localhost:3001"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional()
});

export const env = EnvSchema.parse(process.env);

