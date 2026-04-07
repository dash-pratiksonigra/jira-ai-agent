export type JiraIssue = {
  key: string;
  id: string;
  fields: {
    summary?: string;
    description?: unknown;
    priority?: { name?: string } | null;
    status?: { name?: string; id?: string } | null;
    labels?: string[] | null;
    assignee?: { accountId?: string; displayName?: string } | null;
  };
};

export type JiraSearchResult = {
  issues: JiraIssue[];
};

export type JiraTransition = {
  id: string;
  name: string;
  to?: { name?: string; id?: string };
};

export type JiraMyself = {
  accountId: string;
  displayName: string;
};

export type JiraAdapterOptions = {
  baseUrl: string;
  email: string;
  apiToken: string;
  userAgent?: string;
  maxRetries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
};

export interface JiraAdapter {
  myself(): Promise<JiraMyself>;
  search(jql: string, maxResults: number): Promise<JiraSearchResult>;
  getIssue(issueKey: string): Promise<JiraIssue>;
  getTransitions(issueKey: string): Promise<JiraTransition[]>;
  transitionIssue(issueKey: string, transitionId: string): Promise<void>;
  addComment(issueKey: string, bodyMarkdown: string): Promise<{ id: string }>;
  editIssue(issueKey: string, fields: Record<string, unknown>): Promise<void>;
}

