import { callProvider } from "./smm-providers";
import { mapProviderStatus } from "./smm-status";
import { answer, date, field, isResult, money, one, text, type ReadContext, type Row, type SabitoResult } from "./sabito-read";

export type ProviderStatusRead = (provider: number, order: string, signal?: AbortSignal) => Promise<unknown>;
export const providerStatusRead: ProviderStatusRead = (provider, order, signal) =>
  callProvider(provider, "status", { order }, { signal });
async function order(ctx: ReadContext): Promise<Row | SabitoResult> {
  const reference = field(ctx.job, "order_number");
  if (!reference) return answer("error", "Référence de commande requise.");
  return one(await ctx.read(`SELECT id, service_name, service_category, quantity, status, created_at,
    charge_minor, currency, refunded_at, refunded_amount_minor, provider, provider_order_id, external_order_id
    FROM orders WHERE user_id=? AND (id=? OR provider_order_id=? OR external_order_id=?) LIMIT 2`,
  [ctx.id, reference, reference, reference]));
}
const states: Record<string, SabitoResult["status"]> = {
  pending: "pending", processing: "pending", completed: "confirmed", partial: "ok",
  canceled: "failed", cancelled: "failed", failed: "failed", refunded: "ok",
};
export async function orderStatus(ctx: ReadContext, providerRead: ProviderStatusRead): Promise<SabitoResult> {
  const o = await order(ctx);
  if (isResult(o)) return o;
  let state = text(o.status);
  let remains: number | null = null;
  const quantity = Number(o.quantity);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return { status: "error" };
  const external = text(o.provider_order_id) ?? text(o.external_order_id);
  if (external) {
    // Direct status read only. Never call syncOrderInternal: it may refund money.
    const remote = await providerRead(Number(o.provider), external, ctx.job.signal);
    if (!remote || typeof remote !== "object" || "error" in remote) return { status: "error" };
    const data = remote as Record<string, unknown>;
    if (typeof data.status !== "string" || !data.status.trim()) return { status: "error" };
    state = mapProviderStatus(data.status);
    if (data.remains != null && data.remains !== "") {
      if (typeof data.remains !== "number" && (typeof data.remains !== "string" || !/^\d+$/.test(data.remains))) {
        return { status: "error" };
      }
      const count = Number(data.remains);
      if (!Number.isSafeInteger(count) || count < 0 || count > Number(o.quantity)) return { status: "error" };
      remains = count;
    }
  }
  if (!state || !Object.hasOwn(states, state)) return { status: "error" };
  return answer(states[state]!, state, {
    reference: text(o.id), service: text(o.service_name), categorie_service: text(o.service_category),
    reseau_social: null, quantite: quantity, quantite_restante: remains, date: date(o.created_at),
    montant: money(o.charge_minor), devise: text(o.currency),
    details_transaction: external ? "Statut consulté auprès du fournisseur, sans modification de la commande."
      : "État enregistré dans la plateforme. Progression non disponible.",
  });
}
export async function orderRefundStatus(ctx: ReadContext): Promise<SabitoResult> {
  const o = await order(ctx);
  if (isResult(o)) return o;
  const movements = await ctx.read(`SELECT id, amount_minor, currency, created_at FROM wallet_transactions
    WHERE user_id=? AND reference_type='order' AND reference_id=? AND type='refund' LIMIT 2`, [ctx.id, String(o.id)]);
  if (movements.length > 1) return { status: "error" };
  const m = movements[0];
  if (m) {
    const refunded = money(m.amount_minor);
    if (!o.refunded_at || refunded <= 0 || refunded !== money(o.refunded_amount_minor) ||
        refunded > money(o.charge_minor) || m.currency !== o.currency) return { status: "error" };
    return answer("confirmed", refunded < money(o.charge_minor) ? "Remboursement partiel effectué" : "Remboursement effectué", {
      reference: text(o.id), montant: refunded, devise: text(m.currency), date: date(m.created_at),
      reference_mouvement: text(m.id), details_transaction: "Crédit de remboursement enregistré dans le journal du membre.",
    });
  }
  if (o.refunded_at != null) return answer("error", "Écriture de remboursement non vérifiable.");
  const tickets = await ctx.read(`SELECT short_code, status, created_at FROM tickets WHERE user_id=?
    AND action_type='refund' AND status='open'
    AND (order_local_id=? OR (order_local_id IS NULL AND order_external_id=? AND provider_id=?))
    LIMIT 2`, [ctx.id, String(o.id), String(o.external_order_id ?? o.provider_order_id ?? ""), String(o.provider)]);
  return answer(tickets.length ? "pending" : "ok", tickets.length ? "Remboursement demandé" : "Aucun remboursement enregistré", {
    reference: text(o.id), montant: 0, devise: text(o.currency), date: tickets.length === 1 ? date(tickets[0]!.created_at) : null,
    reference_demande: tickets.length === 1 ? text(tickets[0]!.short_code) : null,
    details_transaction: tickets.length ? "Demande ouverte, sans crédit de remboursement enregistré."
      : "Une annulation ou la fermeture d’un ticket ne prouve pas un remboursement ni un refus.",
  });
}
