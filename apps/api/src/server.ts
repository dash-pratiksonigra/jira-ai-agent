import cors from "cors";
import express from "express";

import { env } from "./env.js";
import { router } from "./http/routes.js";
import { HttpError } from "./http/errors.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api", router);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: message });
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`API listening on :${env.PORT}`);
});

