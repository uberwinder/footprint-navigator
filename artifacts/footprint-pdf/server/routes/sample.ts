import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

const SAMPLE_URLS: Record<string, string> = {
  drawings: "https://pub-2ad499c25d274381bf49e0399161212e.r2.dev/CSP_26-77_Wimbish_WLA_Gym_Addition___Renovations-Drawings.pdf",
  specs:    "https://pub-2ad499c25d274381bf49e0399161212e.r2.dev/CSP_26-77_Wimbish_WLA_Gym_Addition___Renovations_-Specifications.pdf",
};

router.get("/sample/:file", async (req: Request, res: Response) => {
  const raw  = req.params["file"];
  const key  = Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  const url  = SAMPLE_URLS[key];
  if (!url) return res.status(404).json({ error: "Unknown sample file. Use 'drawings' or 'specs'." });

  console.log(`[sample] proxying ${key} from R2`);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sample] fetch failed for ${key}:`, msg);
    return res.status(502).json({ error: `Failed to reach R2: ${msg}` });
  }

  if (!upstream.ok) {
    return res.status(502).json({ error: `R2 returned ${upstream.status}` });
  }

  res.setHeader("Content-Type", "application/pdf");
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  res.setHeader("Cache-Control", "public, max-age=3600");

  const reader = upstream.body!.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); return; }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sample] stream error for ${key}:`, msg);
    if (!res.headersSent) res.status(500).json({ error: msg });
    else res.end();
  }
});

export default router;
