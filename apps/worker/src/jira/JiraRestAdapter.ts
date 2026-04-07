import type { JiraAdapter, JiraAdapterOptions, JiraIssue, JiraSearchResult, JiraTransition, JiraMyself } from "./JiraAdapter.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitteredBackoff(attempt: number, minDelayMs: number, maxDelayMs: number) {
  const exp = Math.min(maxDelayMs, minDelayMs * 2 ** attempt);
  const jitter = Math.random() * exp * 0.2;
  return exp + jitter;
}

export class JiraRestAdapter implements JiraAdapter {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(opts: JiraAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.authHeader = "Basic " + Buffer.from(`${opts.email}:${opts.apiToken}`, "utf8").toString("base64");
    this.userAgent = opts.userAgent ?? "ratifai-jira-agent/0.1";
    this.maxRetries = opts.maxRetries ?? 4;
    this.minDelayMs = opts.minDelayMs ?? 300;
    this.maxDelayMs = opts.maxDelayMs ?? 8000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const resp = await fetch(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            "User-Agent": this.userAgent,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {})
          },
          body: body ? JSON.stringify(body) : undefined
        });

        if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
          const retryAfter = resp.headers.get("retry-after");
          const delay = retryAfter ? Number(retryAfter) * 1000 : jitteredBackoff(attempt, this.minDelayMs, this.maxDelayMs);
          await sleep(Number.isFinite(delay) ? delay : this.minDelayMs);
          continue;
        }

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Jira ${method} ${path} failed: ${resp.status} ${text}`);
        }

        if (resp.status === 204) return undefined as T;
        return (await resp.json()) as T;
      } catch (e) {
        lastErr = e;
        const delay = jitteredBackoff(attempt, this.minDelayMs, this.maxDelayMs);
        await sleep(delay);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Jira request failed");
  }

  async myself(): Promise<JiraMyself> {
    return await this.request("GET", "/rest/api/3/myself");
  }

  async search(jql: string, maxResults: number): Promise<JiraSearchResult> {
    // Atlassian CHANGE-2046: /rest/api/3/search removed; use enhanced JQL search.
    return await this.request("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults,
      fields: ["summary", "description", "priority", "status", "labels", "assignee"]
    });
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    return await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,priority,status,labels,assignee`);
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const res = await this.request<{ transitions: JiraTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    return res.transitions ?? [];
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: transitionId }
    });
  }

  async addComment(issueKey: string, bodyMarkdown: string): Promise<{ id: string }> {
    // Jira Cloud expects ADF for comment body. Convert plain text/markdown-ish into ADF paragraphs.
    const paragraphs = bodyMarkdown
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .reduce<string[]>((acc, line) => {
        if (line === "" && acc.length && acc[acc.length - 1] === "") return acc;
        acc.push(line);
        return acc;
      }, []);

    return await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: {
        type: "doc",
        version: 1,
        content: paragraphs
          .join("\n")
          .split(/\n{2,}/)
          .map((block) => ({
            type: "paragraph",
            content: [{ type: "text", text: block.replace(/\n/g, " ").trim() || " " }]
          }))
      }
    });
  }

  async editIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
    await this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { fields });
  }
}

