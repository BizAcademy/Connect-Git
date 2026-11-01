import { answer, date, field, isResult, money, one, text, type ReadContext, type SabitoResult, type Row } from "./sabito-read";

async function payment(ctx: ReadContext): Promise<Row | SabitoResult> {
  const clauses = ["user_id=?", "COALESCE(method,'') <> 'admin_adjustment'"];
  const params = [ctx.id];
  let reference = false;
  for (const [key, columns] of [
    ["deposit_number", ["id", "order_id", "reference", "provider_reference"]],
    ["transaction_id", ["transaction_id"]],
    ["phone_number", ["phone_number"]],
    ["country", ["country"]], ["payment_method", ["method"]],
  ] as const) {
    const value = field(ctx.job, key);
    if (!value) continue;
    if (["deposit_number", "transaction_id", "phone_number"].includes(key)) reference = true;
    clauses.push(`(${columns.map(column => `${column}=?`).join(" OR ")})`);
    params.push(...columns.map(() => value));
  }
  if (!reference) return answer("error", "Référence du dépôt, identifiant de transaction ou numéro de téléphone requis.");
  return one(await ctx.read(`SELECT id, status, credited_at, amount_minor, currency, method, provider,
    order_id, reference, provider_reference, created_at, bonus_amount_minor, bonus_status, bonus_credited_at, wallet_credited
    FROM payments WHERE ${clauses.join(" AND ")} LIMIT 2`, params));
}
const depositStates: Record<string, SabitoResult["status"]> = {
  pending: "pending", completed: "confirmed", failed: "failed", rejected: "failed",
  canceled: "failed", cancelled: "failed", expired: "failed", irregular: "pending",
};
export async function depositStatus(ctx: ReadContext): Promise<SabitoResult> {
  const p = await payment(ctx);
  if (isResult(p)) return p;
  const state = text(p.status);
  if (!state || !Object.hasOwn(depositStates, state)) return { status: "error" };
  const credited = p.credited_at != null;
  if (credited !== (state === "completed")) return { status: "error" };
  const movements = await ctx.read(`SELECT id, amount_minor, currency, type, created_at FROM wallet_transactions
    WHERE user_id=? AND reference_type='payment' AND reference_id=? AND type='deposit' LIMIT 2`, [ctx.id, String(p.id)]);
  if (credited && movements.length !== 1) return answer("error", "Crédit du dépôt incohérent ou non vérifiable dans le journal.");
  if (!credited && movements.length) return { status: "error" };
  const m = movements[0];
  return answer(depositStates[state]!, state, {
    reference: text(p.order_id) ?? text(p.reference) ?? text(p.provider_reference) ?? text(p.id),
    montant: money(p.amount_minor), devise: text(p.currency), moyen_paiement: text(p.method),
    date: date(p.created_at), credite: credited, portefeuille: text(p.wallet_credited),
    montant_credit_enregistre: m ? money(m.amount_minor) : null,
    devise_credit_enregistre: m ? text(m.currency) : null, date_credit: date(p.credited_at),
    reference_mouvement: m ? text(m.id) : null,
    details_transaction: credited
      ? "Dépôt confirmé avec écriture de crédit enregistrée. Le crédit peut inclure le bonus de dépôt."
      : "Aucun crédit de dépôt enregistré.",
  });
}
export async function depositBonusStatus(ctx: ReadContext): Promise<SabitoResult> {
  const p = await payment(ctx);
  if (isResult(p)) return p;
  const state = text(p.bonus_status);
  const states: Record<string, SabitoResult["status"]> = { credited: "confirmed", pending: "pending", not_eligible: "ok" };
  if (!state || !Object.hasOwn(states, state)) return { status: "error" };
  const credited = p.bonus_credited_at != null;
  if ((state === "credited") !== credited) return { status: "error" };
  if (state === "not_eligible" && !p.credited_at && ["pending", "irregular"].includes(String(p.status))) {
    return answer("pending", "Bonus non attribué — dépôt non crédité", {
      reference: text(p.order_id) ?? text(p.id), montant: null, devise: "XAF",
      etat_enregistre: state, motif: "Éligibilité non confirmée à ce stade.",
      details_transaction: "Le dépôt n’est pas crédité ; la valeur initiale du bonus ne prouve pas une décision définitive.",
    });
  }
  const movements = await ctx.read(`SELECT id, type, amount_minor FROM wallet_transactions WHERE user_id=?
    AND reference_type='payment' AND reference_id=? AND type IN ('deposit','deposit_bonus') LIMIT 3`, [ctx.id, String(p.id)]);
  if (credited && (!p.credited_at || !movements.length)) return { status: "error" };
  if (credited && !movements.some(m => money(m.amount_minor) >= money(p.bonus_amount_minor))) return { status: "error" };
  return answer(states[state]!, state, {
    reference: text(p.order_id) ?? text(p.id), montant: money(p.bonus_amount_minor),
    devise: "XAF", date: date(p.bonus_credited_at), accorde: credited,
    motif: state === "not_eligible" ? "Dépôt enregistré comme non éligible au bonus." : null,
    details_transaction: state === "credited" ? "Bonus enregistré comme crédité, avec mouvement de dépôt ou de bonus."
      : state === "pending" ? "Bonus enregistré en attente." : "Aucun bonus accordé pour ce dépôt.",
  });
}
