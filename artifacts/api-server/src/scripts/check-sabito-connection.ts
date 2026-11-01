import { logger } from "../lib/logger";
import { closeMysqlPool } from "../lib/mysql";
import { runSabitoDiagnostics } from "../lib/sabito-diagnostics";

try {
  const result = await runSabitoDiagnostics();
  for (const check of result.checks) logger.info(check, "Sabito diagnostic");
  logger.info({ code: result.ok ? "CHECKS_OK_MEMBER_TEST_REQUIRED" : "CHECKS_BLOCKED" }, "Sabito diagnostic");
  if (!result.ok) process.exitCode = 1;
} catch {
  logger.warn({ code: "DIAGNOSTIC_FAILED" }, "Sabito diagnostic");
  process.exitCode = 1;
} finally {
  await closeMysqlPool().catch(() => {});
}
