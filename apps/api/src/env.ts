import dotenv from "dotenv";
import { z } from "zod";

// Ensure `.env` is loaded even when started from repo root.
dotenv.config({ path: new URL("../.env", import.meta.url) });

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  SECRETS_MASTER_KEY: z.string().min(16),
  WORKER_API_KEY: z.string().min(16).optional()
});

export const env = EnvSchema.parse(process.env);

