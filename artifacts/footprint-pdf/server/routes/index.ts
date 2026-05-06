import { Router, type IRouter, type Request, type Response } from "express";
import uploadRouter from "./upload.js";
import chatRouter from "./chat.js";
import summarizeRouter from "./summarize.js";
import onboardRouter from "./onboard.js";
import feedbackRouter from "./feedback.js";
import bugReportRouter from "./bug-report.js";

const router: IRouter = Router();

router.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

router.use(uploadRouter);
router.use(chatRouter);
router.use(summarizeRouter);
router.use(onboardRouter);
router.use(feedbackRouter);
router.use(bugReportRouter);

export default router;
