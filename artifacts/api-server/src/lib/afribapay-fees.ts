export interface AfribapayProviderFees {
  fees: number | null;
  taxes: number | null;
  total: number | null;
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