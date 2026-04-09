import http from "node:http";
import { exec } from "node:child_process";
import path from "node:path";
import { env } from "./env.js";
import { FileOAuthProvider } from "./oauth/FileOAuthProvider.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

function resolveCachePath(p: string) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

async function waitForAuthCode(redirectUrl: URL): Promise<string> {
  if (redirectUrl.hostname !== "127.0.0.1" && redirectUrl.hostname !== "localhost") {
    throw new Error(`redirectUrl must be localhost/127.0.0.1, got ${redirectUrl.toString()}`);
  }

  const port = Number(redirectUrl.port || "3344");
  const pathname = redirectUrl.pathname || "/callback";

  return await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (u.pathname !== pathname) {
          res.statusCode = 404;
          res.end("Not found");
          return;
        }
        const code = u.searchParams.get("code");
        if (!code) {
          res.statusCode = 400;
          res.end("Missing ?code=");
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end("Authorized. You can close this tab and return to the terminal.");
        server.close();
        resolve(code);
      } catch (e) {
        server.close();
        reject(e);
      }
    });
    server.listen(port, redirectUrl.hostname, () => {
      // eslint-disable-next-line no-console
      console.log(`Waiting for OAuth redirect at ${redirectUrl.toString()}`);
    });
  });
}

async function main() {
  if (!env.ATLASSIAN_MCP_URL) throw new Error("Missing ATLASSIAN_MCP_URL");

  const redirectUrl = new URL(env.ATLASSIAN_MCP_OAUTH_REDIRECT_URL);
  const cachePath = resolveCachePath(env.ATLASSIAN_MCP_OAUTH_CACHE_PATH);

  // Override redirect behavior to open browser automatically.
  const provider = new (class extends FileOAuthProvider {
    override async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      // eslint-disable-next-line no-console
      console.log("Opening browser for Atlassian MCP authorization...");
      openBrowser(authorizationUrl.toString());
      // Also print the URL in case browser open is blocked.
      // eslint-disable-next-line no-console
      console.log(authorizationUrl.toString());
    }
  })({
    cachePath,
    redirectUrl: redirectUrl.toString(),
    clientName: "ratifai-worker"
  });

  const r1 = await auth(provider, { serverUrl: env.ATLASSIAN_MCP_URL });
  if (r1 === "AUTHORIZED") {
    // eslint-disable-next-line no-console
    console.log("Already authorized (tokens cached).");
    return;
  }

  const code = await waitForAuthCode(redirectUrl);
  const r2 = await auth(provider, { serverUrl: env.ATLASSIAN_MCP_URL, authorizationCode: code });
  if (r2 !== "AUTHORIZED") throw new Error("OAuth flow did not complete");

  // eslint-disable-next-line no-console
  console.log("OAuth authorized. Tokens saved to:", cachePath);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});

