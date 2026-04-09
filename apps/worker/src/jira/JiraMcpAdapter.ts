import type { JiraAdapter, JiraIssue, JiraMyself, JiraSearchResult, JiraTransition } from "./JiraAdapter.js";
import { AtlassianMcpClient } from "./AtlassianMcpClient.js";

type SearchAtlassianResult =
  | { results?: unknown[] }
  | unknown[];

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getProp(obj: unknown, key: string): unknown {
  return isObject(obj) ? obj[key] : undefined;
}

function pickIssueAriIds(results: unknown[]): string[] {
  const ids: string[] = [];
  for (const r of results) {
    const id = getProp(r, "id");
    if (typeof id !== "string") continue;
    // Example: "ari:cloud:jira:<cloudId>:issue/10107"
    if (id.includes(":jira:") && id.includes(":issue/")) ids.push(id);
  }
  return ids;
}

function normalizeIssueKeyFromFetchAtlassian(payload: unknown): string | null {
  // The MCP server can return varying shapes; try common fields.
  const key = getProp(payload, "key");
  if (typeof key === "string" && key) return key;

  const issue = getProp(payload, "issue");
  const issueKey = getProp(issue, "key");
  if (typeof issueKey === "string" && issueKey) return issueKey;

  const data = getProp(payload, "data");
  const dataKey = getProp(data, "key");
  if (typeof dataKey === "string" && dataKey) return dataKey;

  return null;
}

function extractIssuesFromJqlSearchResponse(payload: unknown): JiraIssue[] {
  // Observed variations across MCP clients/tool wrappers:
  // - { issues: JiraIssue[] }
  // - { issues: { issues: JiraIssue[] } }
  // - { data: { issues: JiraIssue[] } }
  const issues1 = getProp(payload, "issues");
  if (Array.isArray(issues1)) return issues1 as JiraIssue[];

  const issues2 = getProp(issues1, "issues");
  if (Array.isArray(issues2)) return issues2 as JiraIssue[];

  const data = getProp(payload, "data");
  const issues3 = getProp(data, "issues");
  if (Array.isArray(issues3)) return issues3 as JiraIssue[];

  return [];
}

export class JiraMcpAdapter implements JiraAdapter {
  private readonly mcp: AtlassianMcpClient;
  private readonly cloudIdOrSiteUrl: string;
  private readonly responseContentFormat: "markdown" | "adf";

  constructor(
    opts:
      | { transport: { mode: "stdio"; commandLine: string }; cloudIdOrSiteUrl: string; responseContentFormat?: "markdown" | "adf" }
      | {
          transport: {
            mode: "remote";
            url: string;
            headers?: Record<string, string>;
            authProvider?: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider;
          };
          cloudIdOrSiteUrl: string;
          responseContentFormat?: "markdown" | "adf";
        }
  ) {
    this.mcp = new AtlassianMcpClient(opts.transport);
    this.cloudIdOrSiteUrl = opts.cloudIdOrSiteUrl;
    this.responseContentFormat = opts.responseContentFormat ?? "markdown";
  }

  async myself(): Promise<JiraMyself> {
    // Not currently needed by the worker; implement when a stable MCP tool exists for it.
    throw new Error("JiraMcpAdapter.myself() not implemented");
  }

  async search(jqlOrNaturalLanguage: string, maxResults: number): Promise<JiraSearchResult> {
    const q = jqlOrNaturalLanguage.trim();
    if (!q) return { issues: [] };

    // If user provided JQL-ish input, use the explicit JQL tool.
    const looksLikeJql = /(^|\s)(project|status|assignee|reporter|created|updated|labels)\s*=|order\s+by|["'=]/i.test(q);
    if (looksLikeJql) {
      const res = await this.mcp.callTool<unknown>("searchJiraIssuesUsingJql", {
        cloudId: this.cloudIdOrSiteUrl,
        jql: q,
        maxResults: Math.min(100, Math.max(1, maxResults)),
        fields: ["summary", "description", "priority", "status", "labels", "assignee", "created"],
        responseContentFormat: this.responseContentFormat
      });
      const issues = extractIssuesFromJqlSearchResponse(res);
      if (issues.length) return { issues };

      // Fallback: Some Atlassian MCP setups accept only UUID cloudIds even though the schema allows site URLs.
      // Rovo search derives cloud context from the token and is more forgiving.
      const raw = await this.mcp.callTool<SearchAtlassianResult>("searchAtlassian", { query: q });
      const results = Array.isArray(raw) ? raw : asArray((raw as any)?.results);
      const issueAris = pickIssueAriIds(results).slice(0, Math.max(1, maxResults));

      const fetchedIssues: JiraIssue[] = [];
      for (const ari of issueAris) {
        const fetched = await this.mcp.callTool<unknown>("fetchAtlassian", { id: ari });
        const key = normalizeIssueKeyFromFetchAtlassian(fetched);
        if (!key) continue;
        const issue = await this.getIssue(key);
        fetchedIssues.push(issue);
      }
      return { issues: fetchedIssues };
    }

    // Natural-language search via Rovo Search, then fetch each issue.
    const raw = await this.mcp.callTool<SearchAtlassianResult>("searchAtlassian", { query: q });
    const results = Array.isArray(raw) ? raw : asArray((raw as any)?.results);
    const issueAris = pickIssueAriIds(results).slice(0, Math.max(1, maxResults));

    const issues: JiraIssue[] = [];
    for (const ari of issueAris) {
      const fetched = await this.mcp.callTool<unknown>("fetchAtlassian", { id: ari });
      const key = normalizeIssueKeyFromFetchAtlassian(fetched);
      if (!key) continue;
      const issue = await this.getIssue(key);
      issues.push(issue);
    }
    return { issues };
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    const res = await this.mcp.callTool<JiraIssue>("getJiraIssue", {
      cloudId: this.cloudIdOrSiteUrl,
      issueIdOrKey: issueKey,
      fields: ["summary", "description", "priority", "status", "labels", "assignee"],
      responseContentFormat: this.responseContentFormat
    });
    return res as JiraIssue;
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const res = await this.mcp.callTool<{ transitions?: JiraTransition[] }>("getTransitionsForJiraIssue", {
      cloudId: this.cloudIdOrSiteUrl,
      issueIdOrKey: issueKey
    });
    return res?.transitions ?? [];
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.mcp.callTool("transitionJiraIssue", {
      cloudId: this.cloudIdOrSiteUrl,
      issueIdOrKey: issueKey,
      transition: { id: transitionId }
    });
  }

  async addComment(issueKey: string, bodyMarkdown: string): Promise<{ id: string }> {
    const res = await this.mcp.callTool<{ id?: string }>("addCommentToJiraIssue", {
      cloudId: this.cloudIdOrSiteUrl,
      issueIdOrKey: issueKey,
      commentBody: bodyMarkdown,
      contentFormat: "markdown",
      responseContentFormat: this.responseContentFormat
    });

    if (!res?.id) return { id: "unknown" };
    return { id: res.id };
  }

  async editIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.mcp.callTool("editJiraIssue", {
      cloudId: this.cloudIdOrSiteUrl,
      issueIdOrKey: issueKey,
      fields,
      contentFormat: "adf",
      responseContentFormat: this.responseContentFormat
    });
  }
}

