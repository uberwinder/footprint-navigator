import { Router, type IRouter, type Request, type Response } from "express";
import uploadRouter from "./upload.js";
import chatRouter from "./chat.js";
import summarizeRouter from "./summarize.js";
import onboardRouter from "./onboard.js";

const router: IRouter = Router();

router.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

router.use(uploadRouter);
router.use(chatRouter);
router.use(summarizeRouter);
router.use(onboardRouter);

export default router;
