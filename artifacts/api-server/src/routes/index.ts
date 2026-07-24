import { Router, type IRouter } from "express";
import healthRouter from "./health";
import smmRouter from "./smm";
import adminRouter from "./admin";
import supportRouter from "./support";
import paymentsRouter from "./payments";
import ticketsRouter from "./tickets";
import profileRouter from "./profile";
import referralsRouter from "./referrals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(smmRouter);
router.use(adminRouter);
router.use(supportRouter);
router.use(paymentsRouter);
router.use(ticketsRouter);
router.use(profileRouter);
router.use(referralsRouter);

export default router;
