type AnthropicMessage = {
  role: "user" | "assistant";
  content: Array<{ type: "text"; text: string }>;
};

type AnthropicResponse = {
  id: string;
  model: string;
  content: Array<{ type: "text"; text: string }>;
};

type AnthropicModelListResponse = {
  data?: Array<{ id: string }>;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class AnthropicClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com"
  ) {}

  private headers() {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    };
  }

  async listModels(): Promise<string[]> {
    const resp = await fetch(`${this.baseUrl}/v1/models`, {
      method: "GET",
      headers: { ...this.headers(), accept: "application/json" }
    });
    if (!resp.ok) throw new Error(`Anthropic models error: ${resp.status} ${await resp.text()}`);
    const json = (await resp.json()) as AnthropicModelListResponse;
    return (json.data ?? []).map((m) => m.id);
  }

  private pickBestModel(models: string[]): string | null {
    const lower = models.map((m) => m.toLowerCase());
    const byPref = (needle: string) => {
      const idx = lower.findIndex((m) => m.includes(needle));
      return idx >= 0 ? models[idx]! : null;
    };
    // Prefer Sonnet for research quality/cost balance.
    return byPref("sonnet") ?? byPref("opus") ?? byPref("haiku") ?? (models[0] ?? null);
  }

  async generateText(prompt: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 1800;
    const temperature = opts?.temperature ?? 0.2;

    const buildBody = (model: string) => ({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }]
        } satisfies AnthropicMessage
      ]
    });

    let lastErr: unknown;
    // Try configured model first, then discovered best model for this account.
    let discoveredBest: string | null = null;
    try {
      const available = await this.listModels();
      discoveredBest = this.pickBestModel(available);
    } catch {
      // ignore discovery errors; we'll fall back to configured model only
    }

    const modelsToTry = [this.model, discoveredBest].filter((v): v is string => Boolean(v)).filter((v, i, a) => a.indexOf(v) === i);

    for (const model of modelsToTry) {
      try {
        for (let attempt = 0; attempt <= 4; attempt++) {
          const resp = await fetch(`${this.baseUrl}/v1/messages`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(buildBody(model))
          });

          if (resp.status === 429 || (resp.status >= 500 && resp.status <= 599)) {
            await sleep(400 * 2 ** attempt);
            continue;
          }

          if (!resp.ok) {
            const text = await resp.text();
            // If model isn't found, try the fallback model next (no retry loop needed).
            if (resp.status === 404 && text.includes("not_found_error") && text.includes("model:")) {
              lastErr = new Error(`Anthropic model not found: ${model} ${text}`);
              break;
            }
            lastErr = new Error(`Anthropic error: ${resp.status} ${text}`);
            throw lastErr;
          }

          const json = (await resp.json()) as AnthropicResponse;
          const text = json.content?.map((c) => c.text).join("") ?? "";
          return text.trim();
        }
      } catch (e) {
        lastErr = e;
        // try next model
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new Error("Anthropic request failed: no response (check network/proxy/API key)");
  }
}

