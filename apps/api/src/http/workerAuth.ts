import { z } from "zod";

// v1: worker is trusted on localhost; keep a simple header key so it can be deployed safely later.
// If unset, endpoints remain open (dev convenience).
export const WorkerAuthSchema = z.object({
  WORKER_API_KEY: z.string().min(16).optional()
});

