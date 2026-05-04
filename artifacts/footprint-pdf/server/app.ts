import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import router from "./routes/index.js";

const app: Express = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.use("/pdf-api", router);

app.get("/pdf-api", (_req: Request, res: Response) => {
  res.json({ name: "footprint-pdf", status: "ok" });
});

export default app;
