import { answer, date, field, isResult, money, one, text, type ReadContext, type SabitoResult } from "./sabito-read";

export async function walletBalance(ctx: ReadContext): Promise<SabitoResult> {
  const rows = await ctx.read("SELECT balance_minor, balance_usd_minor FROM profiles WHERE user_id=? LIMIT 1", [ctx.id]);
  if (!rows[0]) return { status: "not_found" };
  return answer("ok", "Soldes enregistrés", {
    solde_local: money(rows[0].balance_minor), devise_local: "XAF",
    solde_usd: money(rows[0].balance_usd_minor), devise_usd: "USD",
    details_transaction: "Portefeuille local en FCFA internes (XAF) et portefeuille USD distincts, sans conversion ni addition.",
  });
}
const movementLabels: Record<string, string> = {
  deposit: "Crédit de dépôt (peut inclure le bonus de dépôt)", order_debit: "Paiement de commande",
  refund: "Remboursement de commande", deposit_bonus: "Bonus de dépôt",
  referral_referrer_bonus: "Commission de parrainage", referral_referred_bonus: "Bonus de filleul",
  admin_adjustment: "Ajustement du solde par l’administration",
};
export async function walletMovementStatus(ctx: ReadContext): Promise<SabitoResult> {
  const reference = field(ctx.job, "movement_number");
  if (!reference) return answer("error", "Référence du mouvement requise.");
  const type = field(ctx.job, "movement_type");
  if (type && !Object.hasOwn(movementLabels, type)) return { status: "error" };
  const rows = await ctx.read(`SELECT id, amount_minor, currency, type, created_at, reference_id
    FROM wallet_transactions WHERE user_id=? AND (id=? OR reference_id=?)${type ? " AND type=?" : ""} LIMIT 2`,
  [ctx.id, reference, reference, ...(type ? [type] : [])]);
  const m = one(rows);
  if (isResult(m)) return m;
  if (!Object.hasOwn(movementLabels, String(m.type))) return { status: "error" };
  const amount = money(m.amount_minor);
  return answer("confirmed", "Mouvement enregistré", {
    reference: text(m.id), type: text(m.type), sens: amount < 0 ? "débit" : amount > 0 ? "crédit" : "nul",
    montant: Math.abs(amount), devise: text(m.currency), date: date(m.created_at),
    libelle: movementLabels[String(m.type)]!, details_transaction: movementLabels[String(m.type)]!,
    // Do not expose a referral's shared reference, staff identity or internal notes.
    reference_operation: String(m.type).startsWith("referral_") ? null : text(m.reference_id),
  });
}
export async function referralCode(ctx: ReadContext): Promise<SabitoResult> {
  const rows = await ctx.read("SELECT referral_code FROM profiles WHERE user_id=? LIMIT 1", [ctx.id]);
  const code = rows[0]?.referral_code;
  if (code == null || code === "") return { status: "not_found" };
  if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) return { status: "error" };
  return { status: "ok", data: { code } };
}
export async function referralRewardStatus(ctx: ReadContext, referee: boolean): Promise<SabitoResult> {
  const reference = field(ctx.job, "referral_number");
  // All interpolated identifiers below are hardcoded, never taken from a job.
  const owner = referee ? "referred_user_id" : "referrer_user_id";
  const amountColumn = referee ? "referred_bonus_minor" : "referrer_bonus_minor";
  const creditColumn = referee ? "referred_credited_at" : "referrer_credited_at";
  const type = referee ? "referral_referred_bonus" : "referral_referrer_bonus";
  const rows = await ctx.read(`SELECT id, status, ${amountColumn} AS own_amount, ${creditColumn} AS own_credited_at,
    created_at FROM referrals WHERE ${owner}=?${reference ? " AND id=?" : ""} LIMIT 2`, [ctx.id, ...(reference ? [reference] : [])]);
  const r = one(rows);
  if (isResult(r)) return r;
  const movements = await ctx.read(`SELECT id, amount_minor, currency, created_at FROM wallet_transactions
    WHERE user_id=? AND reference_type='referral' AND reference_id=? AND type=? LIMIT 2`, [ctx.id, String(r.id), type]);
  if (movements.length > 1) return { status: "error" };
  const m = movements[0];
  if (!!r.own_credited_at !== !!m) return { status: "error" };
  if (m && money(m.amount_minor) !== money(r.own_amount)) return { status: "error" };
  const state = String(r.status);
  if (!["pending", "processing", "paid"].includes(state)) return { status: "error" };
  if (state === "paid" && !m) return { status: "error" };
  return answer(m ? "confirmed" : "pending", m ? "Récompense créditée" : state, {
    reference: text(r.id), montant: m ? money(m.amount_minor) : r.own_amount == null ? null : money(r.own_amount),
    devise: m ? text(m.currency) : null, date: m ? date(m.created_at) : date(r.created_at),
    reference_mouvement: m ? text(m.id) : null,
    details_transaction: m ? "Écriture de crédit enregistrée pour ce membre."
      : "Aucune écriture de crédit enregistrée pour ce membre ; aucune récompense n’est créée par cette consultation.",
  });
}
