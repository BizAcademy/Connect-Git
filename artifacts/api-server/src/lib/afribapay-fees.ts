export interface AfribapayProviderFees {
  fees: number | null;
  taxes: number | null;
  total: number | null;
}

export interface AfribapayProviderPreview {
  amount: number | null;
  fees: number | null;
  taxes: number | null;
  fees_taxes_ttc: number | null;
  amount_total: number | null;
  currency: string | null;
}

export type FeeReconciliationOutcome = "missing" | "error";

export function feeReconciliationRetryAfterSeconds(
  attemptCount: number,
  outcome: FeeReconciliationOutcome,
): number {
  const schedule = outcome === "error"
    ? [900, 3_600, 21_600, 86_400, 604_800]
    : [3_600, 21_600, 86_400, 604_800, 2_592_000];
  const attempt = Math.max(1, Number.isFinite(attemptCount) ? Math.floor(attemptCount) : 1);
  return schedule[Math.min(attempt - 1, schedule.length - 1)]!;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function amount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Read actual commission/tax amounts from AfribaPAY responses without guessing a tariff. */
export function extractAfribapayProviderFees(payload: unknown): AfribapayProviderFees | null {
  const records: Record<string, unknown>[] = [];
  let current = asRecord(payload);

  for (let depth = 0; current && depth < 4; depth++) {
    records.push(current);
    current = asRecord(current["data"]);
  }

  const sources = records.reverse();
  const providerAmount = (field: string) =>
    sources.map((record) => amount(record[field])).find((value) => value !== null) ?? null;
  const fees = providerAmount("fees");
  const taxes = providerAmount("taxes");
  const reportedTotal = providerAmount("fees_taxes_ttc");
  const total = reportedTotal ?? (fees !== null && taxes !== null ? fees + taxes : null);
  return fees !== null || taxes !== null || total !== null
    ? { fees, taxes, total }
    : null;
}

/** Return only the documented amount fields; never expose provider identifiers or payer data. */
export function extractAfribapayProviderPreview(payload: unknown): AfribapayProviderPreview {
  const records: Record<string, unknown>[] = [];
  let current = asRecord(payload);

  for (let depth = 0; current && depth < 4; depth++) {
    records.push(current);
    current = asRecord(current["data"]);
  }

  const sources = records.reverse();
  const value = (field: string) =>
    sources.find((candidate) => candidate[field] !== undefined && candidate[field] !== null)?.[field];
  const currency = value("currency");
  return {
    amount: amount(value("amount")),
    fees: amount(value("fees")),
    taxes: amount(value("taxes")),
    fees_taxes_ttc: amount(value("fees_taxes_ttc")),
    amount_total: amount(value("amount_total")),
    currency: typeof currency === "string" && currency.trim()
      ? currency.trim().toUpperCase()
      : null,
  };
}