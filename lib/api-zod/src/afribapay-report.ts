import { z } from "zod";

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Date invalide");

export const AfriPayReportQuerySchema = z
  .object({
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    currency: z.string().regex(/^[A-Za-z]{3,8}$/).transform((value) => value.toUpperCase()).optional(),
    country: z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional(),
    operator: z.string().trim().max(80).optional(),
    search: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "La date de fin doit être postérieure ou égale à la date de début",
      });
    }
  })
  .transform((value) => ({
    ...value,
    operator: value.operator || undefined,
    search: value.search || undefined,
  }));

const minorUnits = z.string().regex(/^-?\d+$/);
const nullableMinorUnits = minorUnits.nullable();

export const AfriPayReportDepositSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_label: z.string(),
  user_email: z.string().nullable(),
  phone_number: z.string().nullable(),
  reference: z.string().nullable(),
  created_at: z.string().datetime(),
  country: z.string().nullable(),
  operator: z.string().nullable(),
  currency: z.string().min(1),
  amount_minor: minorUnits,
  charged_minor: nullableMinorUnits,
  provider_fee_minor: nullableMinorUnits,
  provider_tax_minor: nullableMinorUnits,
  provider_fee_total_minor: nullableMinorUnits,
  net_minor: nullableMinorUnits,
});

export const AfriPayReportCurrencySummarySchema = z.object({
  currency: z.string().min(1),
  deposit_count: z.number().int().nonnegative(),
  known_count: z.number().int().nonnegative(),
  unknown_count: z.number().int().nonnegative(),
  gross_minor: minorUnits,
  fees_minor: minorUnits,
  net_minor: minorUnits,
});

export const AfriPayReportResponseSchema = z.object({
  rows: z.array(AfriPayReportDepositSchema),
  total_count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  summary: z.array(AfriPayReportCurrencySummarySchema),
  filters: z.object({
    currencies: z.array(z.string()),
    countries: z.array(z.string()),
    operators: z.array(z.string()),
  }),
});

export const AdminAfribapayProviderPreviewSchema = z.object({
  status: z.string(),
  amount: z.number().nonnegative().nullable(),
  fees: z.number().nonnegative().nullable(),
  taxes: z.number().nonnegative().nullable(),
  fees_taxes_ttc: z.number().nonnegative().nullable(),
  amount_total: z.number().nonnegative().nullable(),
  currency: z.string().nullable(),
  lookup_method: z.enum(["order_id", "transaction_id"]),
});

export type AfriPayReportQuery = z.infer<typeof AfriPayReportQuerySchema>;
export type AfriPayReportDeposit = z.infer<typeof AfriPayReportDepositSchema>;
export type AfriPayReportResponse = z.infer<typeof AfriPayReportResponseSchema>;
export type AdminAfribapayProviderPreview = z.infer<typeof AdminAfribapayProviderPreviewSchema>;