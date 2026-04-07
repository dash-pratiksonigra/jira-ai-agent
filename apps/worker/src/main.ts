import { env } from "./env.js";
import { ApiClient } from "./api/ApiClient.js";
import { JiraRestAdapter } from "./jira/JiraRestAdapter.js";
import { Orchestrator } from "./orchestrator/Orchestrator.js";

type LoadedAgent = {
  id: string;
};

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

      // Jira token is currently stored only in API DB; v1 expects operator to provide it via env.
      // For a full implementation, worker should call API to retrieve the decrypted token (with authz).
      const jiraBaseUrl = process.env.JIRA_BASE_URL;
      const jiraEmail = process.env.JIRA_EMAIL;
      const jiraApiToken = process.env.JIRA_API_TOKEN;
      if (!jiraBaseUrl || !jiraEmail || !jiraApiToken) {
        throw new Error("Missing JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN env vars for worker");
      }

      const jira = new JiraRestAdapter({ baseUrl: jiraBaseUrl, email: jiraEmail, apiToken: jiraApiToken });
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

