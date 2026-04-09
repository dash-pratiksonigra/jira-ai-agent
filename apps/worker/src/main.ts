import { env } from "./env.js";
import { ApiClient } from "./api/ApiClient.js";
import { JiraRestAdapter } from "./jira/JiraRestAdapter.js";
import { JiraMcpAdapter } from "./jira/JiraMcpAdapter.js";
import { Orchestrator } from "./orchestrator/Orchestrator.js";
import { FileOAuthProvider } from "./oauth/FileOAuthProvider.js";
import path from "node:path";

type LoadedAgent = {
  id: string;
};

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

async function fetchAgentConfigs(apiBaseUrl: string) {
  const resp = await fetch(`${apiBaseUrl}/api/agent-configs`);
  if (!resp.ok) throw new Error(`Failed to fetch agent configs: ${resp.status} ${await resp.text()}`);
  return (await resp.json()) as unknown[];
}

async function loop() {
  const workerKey = process.env.WORKER_API_KEY;
  const api = new ApiClient(env.API_BASE_URL, workerKey);

  while (true) {
    const configs = await fetchAgentConfigs(env.API_BASE_URL);

    for (const c of configs) {
      const agent = c as any;
      if (!agent.enabled) continue;

      const jira = (() => {
        const cloudIdOrSiteUrl = env.ATLASSIAN_CLOUD_ID_OR_SITE_URL;

        if (cloudIdOrSiteUrl && env.ATLASSIAN_MCP_URL) {
          const headers = env.ATLASSIAN_MCP_HEADERS_JSON
            ? (JSON.parse(env.ATLASSIAN_MCP_HEADERS_JSON) as Record<string, string>)
            : undefined;

          const authProvider =
            env.ATLASSIAN_MCP_USE_OAUTH && !headers
              ? new FileOAuthProvider({
                  cachePath: resolveWorkerPath(env.ATLASSIAN_MCP_OAUTH_CACHE_PATH),
                  redirectUrl: env.ATLASSIAN_MCP_OAUTH_REDIRECT_URL,
                  clientName: "ratifai-worker"
                })
              : undefined;

          return new JiraMcpAdapter({
            transport: { mode: "remote", url: env.ATLASSIAN_MCP_URL, headers, authProvider },
            cloudIdOrSiteUrl,
            responseContentFormat: "markdown"
          });
        }

        if (cloudIdOrSiteUrl && env.ATLASSIAN_MCP_COMMAND) {
          return new JiraMcpAdapter({
            transport: { mode: "stdio", commandLine: env.ATLASSIAN_MCP_COMMAND },
            cloudIdOrSiteUrl,
            responseContentFormat: "markdown"
          });
        }

        return (() => {
              // Fallback: direct Jira REST (legacy)
              // Jira token is currently stored only in API DB; v1 expects operator to provide it via env.
              // For a full implementation, worker should call API to retrieve the decrypted token (with authz).
              const jiraBaseUrl = process.env.JIRA_BASE_URL;
              const jiraEmail = process.env.JIRA_EMAIL;
              const jiraApiToken = process.env.JIRA_API_TOKEN;
              if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) {
                throw new Error(
                  "Missing Jira configuration. Set ATLASSIAN_CLOUD_ID_OR_SITE_URL + (ATLASSIAN_MCP_URL or ATLASSIAN_MCP_COMMAND) (preferred) or JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN (legacy)."
                );
              }
              return new JiraRestAdapter({ baseUrl: jiraBaseUrl, email: jiraEmail, apiToken: jiraApiToken });
            })();
      })();

      const orch = new Orchestrator({ api, jira });
      await orch.runOnce(agent);
    }

    await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_SECONDS * 1000));
  }
}

loop().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

