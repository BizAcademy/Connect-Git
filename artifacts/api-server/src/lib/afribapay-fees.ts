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

  for (const record of records.reverse()) {
    const fees = amount(record["fees"]);
    const taxes = amount(record["taxes"]);
    const reportedTotal = amount(record["fees_taxes_ttc"]);
    const total = reportedTotal ?? (fees !== null && taxes !== null ? fees + taxes : null);
    if (fees !== null || taxes !== null || total !== null) {
      return { fees, taxes, total };
    }
  }

  return null;
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