import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

type AtlassianToolArgs = Record<string, unknown>;
type McpTool = { name: string; description?: string; inputSchema?: unknown };

function extractErrorText(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  if (!("isError" in res) || !res.isError) return null;
  const content = (res as any).content;
  if (Array.isArray(content)) {
    const texts = content.map((c: any) => (c && typeof c.text === "string" ? c.text : "")).filter(Boolean);
    return texts.join("\n") || "MCP tool call failed";
  }
  return "MCP tool call failed";
}

function tryParseJsonText(text: string): unknown {
  const t = text.trim();
  if (!t) return text;
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return text;
  }
}

function unwrapToolResult(res: any): any {
  // Many hosted MCP tools return `{ content: [{ type: "text", text: "..." }], statusCode, isError }`.
  // For Atlassian MCP, the `text` is often a JSON string. Parse it so callers receive structured data.
  if (!res || typeof res !== "object") return res;
  const content = (res as any).content;
  if (!Array.isArray(content) || content.length !== 1) return res;
  const only = content[0];
  if (!only || typeof only !== "object") return res;
  const text = (only as any).text;
  if (typeof text !== "string") return res;
  return tryParseJsonText(text);
}

type McpExec = {
  command: string;
  args: string[];
};

function parseCommandLine(commandLine: string): McpExec {
  // Minimal argv splitter (supports quotes). Good enough for env-configured commands.
  const args: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < commandLine.length) {
        cur += commandLine[i + 1]!;
        i++;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (quote) throw new Error("Unterminated quote in ATLASSIAN_MCP_COMMAND");
  if (cur) args.push(cur);
  if (!args.length) throw new Error("Empty ATLASSIAN_MCP_COMMAND");

  const [command, ...rest] = args;
  if (!command) throw new Error("Invalid ATLASSIAN_MCP_COMMAND");
  return { command, args: rest };
}

export class AtlassianMcpClient {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;

  constructor(
    private readonly opts:
      | { mode: "stdio"; commandLine: string }
      | { mode: "remote"; url: string; headers?: Record<string, string>; authProvider?: OAuthClientProvider }
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return await this.connecting;

    this.connecting = (async () => {
      const transport =
        this.opts.mode === "stdio"
          ? (() => {
              const exec = parseCommandLine(this.opts.commandLine);
              return new StdioClientTransport({ command: exec.command, args: exec.args });
            })()
          : new StreamableHTTPClientTransport(new URL(this.opts.url), {
              requestInit: {
                headers: this.opts.headers ?? {}
              },
              authProvider: this.opts.authProvider
            });

      const client = new Client(
        { name: "ratifai-worker", version: "0.1.0" },
        { capabilities: {} }
      );
      await client.connect(transport);
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async callTool<T = unknown>(name: string, args: AtlassianToolArgs): Promise<T> {
    const client = await this.connect();
    const res = await client.callTool({ name, arguments: args });
    const err = extractErrorText(res);
    if (err) throw new Error(err);
    return unwrapToolResult(res) as T;
  }

  async listTools(): Promise<McpTool[]> {
    const client = await this.connect();
    const res = await client.listTools();
    return (res as any)?.tools ?? [];
  }
}

