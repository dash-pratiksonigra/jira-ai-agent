import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Load env from a predictable place:
// - when running from repo root: apps/worker/.env
// - when running from apps/worker: .env
// - otherwise: rely on process.env only
const repoRootWorkerEnv = path.join(process.cwd(), "apps", "worker", ".env");
const localWorkerEnv = path.join(process.cwd(), ".env");
const envPath = fs.existsSync(repoRootWorkerEnv) ? repoRootWorkerEnv : fs.existsSync(localWorkerEnv) ? localWorkerEnv : null;
if (envPath) dotenv.config({ path: envPath });

const EnvSchema = z.object({
  API_BASE_URL: z.string().url().default("http://localhost:3001"),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(120),
  ATLASSIAN_MCP_COMMAND: z.string().min(1).optional(),
  ATLASSIAN_MCP_URL: z.string().url().optional(),
  ATLASSIAN_MCP_HEADERS_JSON: z.string().min(2).optional(),
  ATLASSIAN_MCP_USE_OAUTH: z.coerce.boolean().default(false),
  ATLASSIAN_MCP_OAUTH_CACHE_PATH: z.string().min(1).default("apps/worker/.atlassian-mcp-oauth.json"),
  ATLASSIAN_MCP_OAUTH_REDIRECT_URL: z.string().url().default("http://127.0.0.1:3344/callback"),
  ATLASSIAN_CLOUD_ID_OR_SITE_URL: z.string().min(1).optional(),
  REPO_ROOT: z.string().min(1).optional(),
  RUN_TESTS_COMMAND: z.string().min(1).optional(),
  PR_BASE_BRANCH: z.string().min(1).default("develop"),
  PR_REMOTE: z.string().min(1).default("origin"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().optional()
});

export const env = EnvSchema.parse(process.env);

