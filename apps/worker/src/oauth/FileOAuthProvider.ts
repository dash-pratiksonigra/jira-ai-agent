import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";

type CacheShape = {
  clientInformation?: any;
  tokens?: any;
  codeVerifier?: string;
  discoveryState?: any;
};

function base64url(bytes: Buffer) {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function readJson(filePath: string): Promise<CacheShape> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as CacheShape;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJson(filePath: string, value: CacheShape): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly opts: {
      cachePath: string;
      redirectUrl: string;
      clientName?: string;
    }
  ) {}

  get redirectUrl() {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): any {
    return {
      client_name: this.opts.clientName ?? "ratifai-worker",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    } as any;
  }

  async state(): Promise<string> {
    return base64url(crypto.randomBytes(16));
  }

  async clientInformation(): Promise<any | undefined> {
    const cache = await readJson(this.opts.cachePath);
    return cache.clientInformation;
  }

  async saveClientInformation(clientInformation: any): Promise<void> {
    const cache = await readJson(this.opts.cachePath);
    cache.clientInformation = clientInformation;
    await writeJson(this.opts.cachePath, cache);
  }

  async tokens(): Promise<any | undefined> {
    const cache = await readJson(this.opts.cachePath);
    return cache.tokens;
  }

  async saveTokens(tokens: any): Promise<void> {
    const cache = await readJson(this.opts.cachePath);
    cache.tokens = tokens;
    await writeJson(this.opts.cachePath, cache);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const cache = await readJson(this.opts.cachePath);
    cache.codeVerifier = codeVerifier;
    await writeJson(this.opts.cachePath, cache);
  }

  async codeVerifier(): Promise<string> {
    const cache = await readJson(this.opts.cachePath);
    if (!cache.codeVerifier) throw new Error("Missing OAuth code verifier in cache");
    return cache.codeVerifier;
  }

  async saveDiscoveryState(state: any): Promise<void> {
    const cache = await readJson(this.opts.cachePath);
    cache.discoveryState = state;
    await writeJson(this.opts.cachePath, cache);
  }

  async discoveryState(): Promise<any | undefined> {
    const cache = await readJson(this.opts.cachePath);
    return cache.discoveryState;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // In worker mode, we can't guarantee a browser or local callback server.
    // Provide a clear instruction to run the interactive login script.
    // eslint-disable-next-line no-console
    console.log("Open this URL to authorize Atlassian MCP:", authorizationUrl.toString());
    throw new Error(
      "OAuth authorization required. Run `node apps/worker/dist/mcpOauthLogin.js` once to complete OAuth, then restart the worker."
    );
  }
}

