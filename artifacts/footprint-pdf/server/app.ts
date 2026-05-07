import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import router from "./routes/index.js";

const app: Express = express();

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ extended: true, limit: "100mb" }));

app.use("/pdf-api", router);

app.get("/pdf-api", (_req: Request, res: Response) => {
  res.json({ name: "footprint-pdf", status: "ok" });
});

app.get("/pdf-api/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// UptimeRobot-compatible ping routes (no base path prefix)
app.get("/ping",     (_req: Request, res: Response) => res.json({ ok: true, timestamp: new Date().toISOString() }));
app.get("/api/ping", (_req: Request, res: Response) => res.json({ ok: true, timestamp: new Date().toISOString() }));

export default app;
