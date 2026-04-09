import { env } from "./env.js";
import { AtlassianMcpClient } from "./jira/AtlassianMcpClient.js";
import { FileOAuthProvider } from "./oauth/FileOAuthProvider.js";
import path from "node:path";

function resolveWorkerPath(p: string): string {
  if (path.isAbsolute(p)) return p;
  const cwd = process.cwd();
  const norm = p.replace(/\\/g, "/");
  const inWorkerDir = /[\\/]apps[\\/]worker$/i.test(cwd);
  if (inWorkerDir && norm.startsWith("apps/worker/")) {
    return path.join(cwd, norm.slice("apps/worker/".length));
  }
  return path.join(cwd, p);
}

function safeJsonParse(v: string): Record<string, string> | undefined {
  try {
    return JSON.parse(v) as Record<string, string>;
  } catch (e) {
    throw new Error(`Invalid ATLASSIAN_MCP_HEADERS_JSON: ${(e as Error).message}`);
  }
}

async function main() {
  if (!env.ATLASSIAN_MCP_URL) throw new Error("Missing ATLASSIAN_MCP_URL");
  if (!env.ATLASSIAN_CLOUD_ID_OR_SITE_URL) throw new Error("Missing ATLASSIAN_CLOUD_ID_OR_SITE_URL");

  const headers = env.ATLASSIAN_MCP_HEADERS_JSON ? safeJsonParse(env.ATLASSIAN_MCP_HEADERS_JSON) : undefined;
  const authProvider =
    env.ATLASSIAN_MCP_USE_OAUTH
      ? new FileOAuthProvider({
          cachePath: resolveWorkerPath(env.ATLASSIAN_MCP_OAUTH_CACHE_PATH),
          redirectUrl: env.ATLASSIAN_MCP_OAUTH_REDIRECT_URL,
          clientName: "ratifai-worker"
        })
      : undefined;

  const mcp = new AtlassianMcpClient({ mode: "remote", url: env.ATLASSIAN_MCP_URL, headers, authProvider });

  const tools = await mcp.listTools();

  // 1) Basic connectivity + auth: list projects
  const toolsByName = new Set(tools.map((t) => t.name));
  const canProjects = toolsByName.has("getVisibleJiraProjects");
  const canJql = toolsByName.has("searchJiraIssuesUsingJql");
  const canRovo = toolsByName.has("searchAtlassian");

  const projects = canProjects
    ? await mcp.callTool<any>("getVisibleJiraProjects", {
        cloudId: env.ATLASSIAN_CLOUD_ID_OR_SITE_URL,
        maxResults: 50,
        action: "browse",
        expandIssueTypes: false
      })
    : null;

  const jqlRes = canJql
    ? await mcp.callTool<any>("searchJiraIssuesUsingJql", {
        cloudId: env.ATLASSIAN_CLOUD_ID_OR_SITE_URL,
        // Jira may reject unbounded JQL (no restriction). Keep it bounded.
        jql: "project = RATIFAI ORDER BY created DESC",
        maxResults: 1,
        fields: ["summary", "status", "created", "project", "issuetype"],
        responseContentFormat: "markdown"
      })
    : null;

  const rovo = canRovo ? await mcp.callTool<any>("searchAtlassian", { query: "project = RATIFAI ORDER BY created DESC" }) : null;

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        ok: true,
        toolCount: tools.length,
        toolNamesSample: tools.slice(0, 60).map((t) => t.name),
        projectsSample: Array.isArray(projects) ? projects.slice(0, 5) : projects,
        jqlSearchSample: jqlRes,
        rovoSearchSample: rovo
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

