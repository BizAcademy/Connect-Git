import { Router, type IRouter } from "express";
import type { RowDataPacket } from "mysql2/promise";
import {
  AdminAfribapayProviderPreviewSchema,
  AfriPayReportQuerySchema,
  AfriPayReportResponseSchema,
  type AfriPayReportQuery,
} from "@workspace/api-zod";
import { requireAdmin, requireUser, type AuthedRequest } from "../lib/auth";
import { getStatus, isAfribapayConfigured, type StatusLookupBy } from "../lib/afribapay";
import { getMysqlPool } from "../lib/mysql";
import { extractAfribapayProviderPreview } from "../lib/afribapay-fees";

const router: IRouter = Router();
const previewInFlightAdmins = new Set<string>();
const previewLastRequestByAdmin = new Map<string, number>();
const PROVIDER_PREVIEW_COOLDOWN_MS = 3_000;
const BASE_CONDITIONS = [
  "p.status = 'completed'",
  "(p.provider = 'afribapay' OR p.method = 'afribapay')",
];

function buildWhere(filters: AfriPayReportQuery): {
  sql: string;
  values: string[];
} {
  const conditions = [...BASE_CONDITIONS];
  const values: string[] = [];

  if (filters.from) {
    conditions.push("p.created_at >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    conditions.push("p.created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    values.push(filters.to);
  }
  if (filters.currency) {
    conditions.push("COALESCE(NULLIF(UPPER(p.currency), ''), 'XAF') = ?");
    values.push(filters.currency);
  }
  if (filters.country) {
    conditions.push("UPPER(p.country) = ?");
    values.push(filters.country);
  }
  if (filters.operator) {
    conditions.push("TRIM(p.operator) = ?");
    values.push(filters.operator);
  }
  if (filters.search) {
    conditions.push(`(
      p.user_id LIKE ?
      OR pr.username LIKE ?
      OR pr.email LIKE ?
      OR p.phone_number LIKE ?
      OR p.transaction_id LIKE ?
      OR p.order_id LIKE ?
      OR p.provider_reference LIKE ?
    )`);
    const search = `%${filters.search}%`;
    values.push(search, search, search, search, search, search, search);
  }

  return { sql: conditions.join(" AND "), values };
}

function asNullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

router.get(
  "/admin/afribapay/deposits",
  requireUser,
  requireAdmin,
  async (req, res): Promise<void> => {
    const parsedFilters = AfriPayReportQuerySchema.safeParse(req.query);
    if (!parsedFilters.success) {
      res.status(400).json({ error: parsedFilters.error.message });
      return;
    }

    const filters = parsedFilters.data;
    const where = buildWhere(filters);
    const pool = getMysqlPool();

    try {
      const [countRows] = await pool.execute<RowDataPacket[]>(
        `SELECT COUNT(*) AS total_count
         FROM payments p
         LEFT JOIN profiles pr ON pr.user_id = p.user_id
         WHERE ${where.sql}`,
        where.values,
      );

      const [summaryRows] = await pool.execute<RowDataPacket[]>(
        `SELECT
           COALESCE(NULLIF(UPPER(p.currency), ''), 'XAF') AS currency,
           COUNT(*) AS deposit_count,
           SUM(CASE
             WHEN p.charge_minor IS NOT NULL AND p.provider_fee_total_minor IS NOT NULL
             THEN 1 ELSE 0
           END) AS known_count,
           SUM(CASE
             WHEN p.charge_minor IS NULL OR p.provider_fee_total_minor IS NULL
             THEN 1 ELSE 0
           END) AS unknown_count,
           CAST(COALESCE(SUM(CASE
             WHEN p.charge_minor IS NOT NULL AND p.provider_fee_total_minor IS NOT NULL
             THEN p.charge_minor ELSE 0
           END), 0) AS CHAR) AS gross_minor,
           CAST(COALESCE(SUM(CASE
             WHEN p.charge_minor IS NOT NULL AND p.provider_fee_total_minor IS NOT NULL
             THEN p.provider_fee_total_minor ELSE 0
           END), 0) AS CHAR) AS fees_minor,
           CAST(COALESCE(SUM(CASE
             WHEN p.charge_minor IS NOT NULL AND p.provider_fee_total_minor IS NOT NULL
             THEN p.charge_minor - p.provider_fee_total_minor ELSE 0
           END), 0) AS CHAR) AS net_minor
         FROM payments p
         LEFT JOIN profiles pr ON pr.user_id = p.user_id
         WHERE ${where.sql}
         GROUP BY COALESCE(NULLIF(UPPER(p.currency), ''), 'XAF')
         ORDER BY currency`,
        where.values,
      );

      const [depositRows] = await pool.execute<RowDataPacket[]>(
        `SELECT
           p.id,
           p.user_id,
           COALESCE(NULLIF(TRIM(pr.username), ''), NULLIF(TRIM(pr.email), ''), p.user_id) AS user_label,
           pr.email AS user_email,
           p.phone_number,
           COALESCE(
             NULLIF(p.transaction_id, ''),
             NULLIF(p.order_id, ''),
             NULLIF(p.provider_reference, '')
           ) AS reference,
           p.created_at,
           p.country,
           NULLIF(TRIM(p.operator), '') AS operator,
           COALESCE(NULLIF(UPPER(p.currency), ''), 'XAF') AS currency,
           CAST(p.amount_minor AS CHAR) AS amount_minor,
           CASE WHEN p.charge_minor IS NULL THEN NULL
             ELSE CAST(p.charge_minor AS CHAR) END AS charged_minor,
           CASE WHEN p.provider_fee_minor IS NULL THEN NULL
             ELSE CAST(p.provider_fee_minor AS CHAR) END AS provider_fee_minor,
           CASE WHEN p.provider_tax_minor IS NULL THEN NULL
             ELSE CAST(p.provider_tax_minor AS CHAR) END AS provider_tax_minor,
           CASE WHEN p.provider_fee_total_minor IS NULL THEN NULL
             ELSE CAST(p.provider_fee_total_minor AS CHAR) END AS provider_fee_total_minor,
           CASE
             WHEN p.charge_minor IS NULL OR p.provider_fee_total_minor IS NULL THEN NULL
             ELSE CAST(p.charge_minor - p.provider_fee_total_minor AS CHAR)
           END AS net_minor
         FROM payments p
         LEFT JOIN profiles pr ON pr.user_id = p.user_id
         WHERE ${where.sql}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT ? OFFSET ?`,
        [...where.values, filters.limit, filters.offset],
      );

      const [facetRows] = await pool.execute<RowDataPacket[]>(
        `SELECT DISTINCT
           COALESCE(NULLIF(UPPER(p.currency), ''), 'XAF') AS currency,
           UPPER(NULLIF(p.country, '')) AS country,
           NULLIF(TRIM(p.operator), '') AS operator
         FROM payments p
         WHERE p.status = 'completed'
           AND (p.provider = 'afribapay' OR p.method = 'afribapay')
         ORDER BY currency, country, operator`,
      );

      const response = AfriPayReportResponseSchema.parse({
        rows: depositRows.map((row) => ({
          id: String(row.id),
          user_id: String(row.user_id),
          user_label: String(row.user_label),
          user_email: asNullableString(row.user_email),
          phone_number: asNullableString(row.phone_number),
          reference: asNullableString(row.reference),
          created_at: new Date(row.created_at).toISOString(),
          country: asNullableString(row.country),
          operator: asNullableString(row.operator),
          currency: String(row.currency),
          amount_minor: String(row.amount_minor),
          charged_minor: asNullableString(row.charged_minor),
          provider_fee_minor: asNullableString(row.provider_fee_minor),
          provider_tax_minor: asNullableString(row.provider_tax_minor),
          provider_fee_total_minor: asNullableString(row.provider_fee_total_minor),
          net_minor: asNullableString(row.net_minor),
        })),
        total_count: Number(countRows[0]?.["total_count"] ?? 0),
        limit: filters.limit,
        offset: filters.offset,
        summary: summaryRows.map((row) => ({
          currency: String(row.currency),
          deposit_count: Number(row.deposit_count),
          known_count: Number(row.known_count),
          unknown_count: Number(row.unknown_count),
          gross_minor: String(row.gross_minor),
          fees_minor: String(row.fees_minor),
          net_minor: String(row.net_minor),
        })),
        filters: {
          currencies: [...new Set(facetRows.map((row) => String(row.currency)))],
          countries: [
            ...new Set(
              facetRows
                .map((row) => asNullableString(row.country))
                .filter((value): value is string => value !== null),
            ),
          ],
          operators: [
            ...new Set(
              facetRows
                .map((row) => asNullableString(row.operator))
                .filter((value): value is string => value !== null),
            ),
          ],
        },
      });

      res.json(response);
    } catch (err) {
      req.log.error({ err }, "admin AfribaPAY deposit report failed");
      res.status(500).json({ error: "Impossible de charger le rapport AfribaPAY" });
    }
  },
);

router.get(
  "/admin/afribapay/deposits/:payment_id/provider-preview",
  requireUser,
  requireAdmin,
  async (req: AuthedRequest, res): Promise<void> => {
    const rawPaymentId = req.params["payment_id"];
    const paymentId = Array.isArray(rawPaymentId) ? rawPaymentId[0] : rawPaymentId;
    if (!paymentId || paymentId.length > 100) {
      res.status(400).json({ error: "Identifiant de dépôt invalide" });
      return;
    }

    if (!isAfribapayConfigured()) {
      res.status(503).json({ error: "AfribaPAY n’est pas configuré sur ce serveur" });
      return;
    }

    const adminId = req.userId ?? "";
    const now = Date.now();
    if (
      !adminId
      || previewInFlightAdmins.has(adminId)
      || now - (previewLastRequestByAdmin.get(adminId) ?? 0) < PROVIDER_PREVIEW_COOLDOWN_MS
    ) {
      res.status(429).json({ error: "Attendez quelques secondes avant une nouvelle vérification." });
      return;
    }

    previewInFlightAdmins.add(adminId);
    previewLastRequestByAdmin.set(adminId, now);
    const pool = getMysqlPool();
    try {
      const [rows] = await pool.execute<RowDataPacket[]>(
        `SELECT status, provider, method, order_id, transaction_id
         FROM payments
         WHERE id = ?
         LIMIT 1`,
        [paymentId],
      );
      const payment = rows[0];
      if (!payment) {
        res.status(404).json({ error: "Dépôt AfribaPAY introuvable" });
        return;
      }
      if (
        String(payment["status"]).toLowerCase() !== "completed"
        || (payment["provider"] !== "afribapay" && payment["method"] !== "afribapay")
      ) {
        res.status(409).json({ error: "Seuls les dépôts AfribaPAY terminés peuvent être vérifiés." });
        return;
      }

      const orderId = payment["order_id"] == null ? "" : String(payment["order_id"]).trim();
      const transactionId = payment["transaction_id"] == null ? "" : String(payment["transaction_id"]).trim();
      const lookupBy: StatusLookupBy = orderId ? "order_id" : "transaction_id";
      const lookupValue = orderId || transactionId;
      if (!lookupValue) {
        res.status(409).json({ error: "Aucune référence AfribaPAY n’est enregistrée pour ce dépôt." });
        return;
      }

      try {
        const remote = await getStatus(lookupValue, lookupBy);
        const response = AdminAfribapayProviderPreviewSchema.parse({
          status: remote.status || "UNKNOWN",
          ...extractAfribapayProviderPreview(remote.raw),
          lookup_method: lookupBy,
        });
        res.json(response);
      } catch (err) {
        const providerStatus = typeof err === "object" && err !== null && "status" in err
          ? Number((err as { status?: unknown }).status)
          : undefined;
        if (providerStatus === 429) {
          res.status(429).json({ error: "AfribaPAY limite temporairement les vérifications. Réessayez plus tard." });
          return;
        }
        req.log.warn(
          { provider_status: providerStatus ?? null },
          "AfribaPAY admin read-only status lookup failed",
        );
        res.status(502).json({ error: "AfribaPAY n’a pas pu fournir le statut de ce dépôt." });
      }
    } catch (err) {
      req.log.error({ err }, "AfribaPAY admin preview database lookup failed");
      res.status(500).json({ error: "Impossible de vérifier ce dépôt AfribaPAY." });
    } finally {
      previewInFlightAdmins.delete(adminId);
    }
  },
);

export default router;