import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CircleDollarSign,
  Clock3,
  Download,
  Eye,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  AdminAfribapayProviderPreviewSchema,
  AfriPayReportResponseSchema,
  type AdminAfribapayProviderPreview,
  type AfriPayReportDeposit,
} from "@workspace/api-zod";
import { authedFetch } from "@/lib/authFetch";

const PAGE_SIZE = 25;
const REFRESH_MS = 60_000;

type Filters = {
  from: string;
  to: string;
  currency: string;
  country: string;
  operator: string;
  search: string;
};

const initialFilters: Filters = {
  from: "",
  to: "",
  currency: "",
  country: "",
  operator: "",
  search: "",
};

function formatCount(value: number) {
  return new Intl.NumberFormat("fr-FR").format(value);
}

/**
 * Payment amounts are stored in hundredths for every currency, even when the
 * currency normally displays without fractional digits. Keep that storage scale
 * fixed so XAF/XOF totals are not accidentally shown 100 times too large.
 */
function formatMinor(value: string | null | undefined, currency: string) {
  if (value == null) return "—";
  try {
    const amount = BigInt(value);
    const fractionDigits = 2;
    const divisor = 100n;
    const negative = amount < 0n;
    const absolute = negative ? -amount : amount;
    const whole = absolute / divisor;
    const fraction = absolute % divisor;
    const wholeText = new Intl.NumberFormat("fr-FR", {
      maximumFractionDigits: 0,
    }).format(whole);
    const fractionText =
      fraction !== 0n || currency === "USD"
        ? `,${fraction.toString().padStart(fractionDigits, "0")}`
        : "";
    return `${negative ? "−" : ""}${wholeText}${fractionText} ${currency}`;
  } catch {
    return `${value} ${currency}`;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatProviderAmount(value: number | null, currency: string | null) {
  if (value == null) return "Non fourni";
  const formatted = new Intl.NumberFormat("fr-FR", {
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

function getNet(row: AfriPayReportDeposit): string | null {
  if (row.charged_minor == null || row.provider_fee_total_minor == null) return null;
  return (BigInt(row.charged_minor) - BigInt(row.provider_fee_total_minor)).toString();
}

async function fetchProviderPreview(paymentId: string): Promise<AdminAfribapayProviderPreview> {
  const response = await authedFetch(
    `/api/admin/afribapay/deposits/${encodeURIComponent(paymentId)}/provider-preview`,
    { method: "GET" },
  );
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error responses are reported with a stable message below.
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `La vérification a échoué (erreur ${response.status}).`;
    throw new Error(message);
  }
  return AdminAfribapayProviderPreviewSchema.parse(payload);
}

async function fetchAfribaReport(filters: Filters, offset: number, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "currency", "country", "operator", "search"] as const) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const response = await authedFetch(`/api/admin/afribapay/deposits?${params.toString()}`, {
    method: "GET",
    signal,
  });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Vous n’avez pas l’autorisation de consulter ce rapport."
        : `Le rapport n’a pas pu être chargé (erreur ${response.status}).`,
    );
  }
  const json: unknown = await response.json();
  return AfriPayReportResponseSchema.parse(json);
}

function SkeletonRows() {
  return (
    <div className="animate-pulse space-y-3 p-5" aria-label="Chargement du rapport">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="grid grid-cols-4 gap-4">
          <div className="h-4 rounded bg-[#e9e5db]" />
          <div className="h-4 rounded bg-[#e9e5db]" />
          <div className="h-4 rounded bg-[#e9e5db]" />
          <div className="h-4 rounded bg-[#e9e5db]" />
        </div>
      ))}
    </div>
  );
}

function UnknownFlag({ id }: { id: string }) {
  return (
    <span data-testid={`status-afribapay-cost-unknown-${id}`} className="inline-flex items-center gap-1.5 rounded-full border border-[#e9c77d] bg-[#fff7e3] px-2.5 py-1 text-[11px] font-semibold text-[#8b5b0a]">
      <AlertTriangle size={12} aria-hidden="true" />
      Montant ou frais inconnus
    </span>
  );
}

export default function AdminAfribapay() {
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [offset, setOffset] = useState(0);
  const [previewingPaymentId, setPreviewingPaymentId] = useState<string | null>(null);
  const [providerPreview, setProviderPreview] = useState<AdminAfribapayProviderPreview | null>(null);
  const [providerPreviewError, setProviderPreviewError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["admin", "afribapay-deposits", filters, offset, PAGE_SIZE],
    queryFn: ({ signal }) => fetchAfribaReport(filters, offset, signal),
    staleTime: 30_000,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  const report = query.data;
  const pageCount = report ? Math.max(1, Math.ceil(report.total_count / PAGE_SIZE)) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const lastRefreshed = query.dataUpdatedAt
    ? new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
        query.dataUpdatedAt,
      )
    : null;
  const filterCount = useMemo(
    () => Object.values(filters).filter(Boolean).length,
    [filters],
  );

  const updateFilter = (key: keyof Filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setOffset(0);
  };

  const clearFilters = () => {
    setFilters(initialFilters);
    setOffset(0);
  };

  const checkProviderStatus = async (paymentId: string) => {
    if (previewingPaymentId) return;
    setPreviewingPaymentId(paymentId);
    setProviderPreview(null);
    setProviderPreviewError(null);
    try {
      setProviderPreview(await fetchProviderPreview(paymentId));
    } catch (error) {
      setProviderPreviewError(
        error instanceof Error ? error.message : "La vérification AfribaPAY a échoué.",
      );
    } finally {
      setPreviewingPaymentId(null);
    }
  };

  const clearProviderPreview = () => {
    setProviderPreview(null);
    setProviderPreviewError(null);
  };

  return (
    <main className="min-h-[70dvh] space-y-6 text-[#24342f]">
      <header className="relative overflow-hidden rounded-[1.35rem] bg-[#173d35] px-5 py-6 text-[#f6f3e9] shadow-[0_16px_38px_-24px_rgba(19,51,43,.65)] sm:px-8 sm:py-8">
        <div className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full border border-[#94b8a6]/20" />
        <div className="pointer-events-none absolute -right-1 top-2 h-36 w-36 rounded-full border border-[#94b8a6]/20" />
        <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <div>
            <div className="mb-4 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[#b9d2c4]">
              <span className="h-2 w-2 rounded-full bg-[#d4a84f]" />
              Registre des dépôts
            </div>
            <h1 className="font-heading text-3xl font-semibold tracking-[-0.045em] sm:text-[2.65rem]">
              AfribaPAY
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#c4d5cc]">
              Dépôts réussis, frais réels et net encaissé. Chaque devise reste distincte ; aucune estimation n’entre dans les totaux.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-white/15 bg-white/[0.07] px-3 py-2 text-xs text-[#d8e4dd]">
              <Clock3 size={14} className="text-[#d4b76f]" />
              <span>{lastRefreshed ? `Actualisé à ${lastRefreshed}` : "En attente des données"}</span>
            </div>
            <button
              type="button"
              data-testid="button-refresh-afribapay"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#e2bc67] px-4 text-sm font-bold text-[#183b33] transition hover:bg-[#efd18b] disabled:cursor-wait disabled:opacity-70"
            >
              <RefreshCw size={15} className={query.isFetching ? "animate-spin" : ""} />
              Actualiser
            </button>
          </div>
        </div>
        <div className="relative mt-6 flex items-center gap-2 border-t border-white/15 pt-4 text-xs text-[#b9d2c4]">
          <ShieldCheck size={15} className="text-[#d4b76f]" />
          Source de vérité : montants transmis par le fournisseur · actualisation automatique chaque minute
        </div>
      </header>

      {(previewingPaymentId || providerPreview || providerPreviewError) && (
        <section
          aria-label="Résultat de la vérification AfribaPAY"
          aria-live="polite"
          className="rounded-2xl border border-[#d8dfd3] bg-[#f8faf5] p-4 sm:p-5"
          data-testid="panel-afribapay-provider-preview"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold text-[#243b32]">
                Vérification directe AfribaPAY
              </h2>
              <p className="mt-1 text-xs text-[#68776e]">
                Lecture seule : aucune donnée n’a été enregistrée dans le rapport.
              </p>
            </div>
            <button
              type="button"
              aria-label="Fermer le résultat"
              onClick={clearProviderPreview}
              disabled={previewingPaymentId !== null}
              className="rounded-lg p-2 text-[#68776e] hover:bg-[#e9eee5] disabled:opacity-50"
            >
              <X size={16} />
            </button>
          </div>
          {previewingPaymentId && (
            <p className="mt-3 text-sm text-[#53665b]">Consultation d’une transaction auprès d’AfribaPAY…</p>
          )}
          {providerPreviewError && (
            <p role="alert" className="mt-3 text-sm font-medium text-[#984a39]">
              {providerPreviewError}
            </p>
          )}
          {providerPreview && (
            <>
              <p className="mt-3 text-xs text-[#68776e]">
                Recherche par {providerPreview.lookup_method === "order_id" ? "référence de commande" : "identifiant de transaction"}.
              </p>
              <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Statut fournisseur</dt>
                  <dd className="mt-1 font-semibold text-[#29483a]">{providerPreview.status}</dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Montant API (`amount`)</dt>
                  <dd className="mt-1 font-mono text-[#29483a]">
                    {formatProviderAmount(providerPreview.amount, providerPreview.currency)}
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Frais API (`fees`)</dt>
                  <dd className="mt-1 font-mono text-[#29483a]">
                    {formatProviderAmount(providerPreview.fees, providerPreview.currency)}
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Taxes API (`taxes`)</dt>
                  <dd className="mt-1 font-mono text-[#29483a]">
                    {formatProviderAmount(providerPreview.taxes, providerPreview.currency)}
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Frais et taxes TTC (`fees_taxes_ttc`)</dt>
                  <dd className="mt-1 font-mono text-[#29483a]">
                    {formatProviderAmount(providerPreview.fees_taxes_ttc, providerPreview.currency)}
                  </dd>
                </div>
                <div className="rounded-xl bg-white p-3">
                  <dt className="text-xs text-[#77847c]">Total communiqué (`amount_total`; sens à confirmer)</dt>
                  <dd className="mt-1 font-mono text-[#29483a]">
                    {formatProviderAmount(providerPreview.amount_total, providerPreview.currency)}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </section>
      )}

      {query.isError && !report ? (
        <section className="rounded-2xl border border-[#e6c5bd] bg-[#fff7f4] p-6 sm:p-8" role="alert">
          <div className="flex gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f7e3dd] text-[#9b4935]">
              <AlertTriangle size={20} />
            </div>
            <div className="flex-1">
              <h2 className="font-heading text-lg font-semibold">Le rapport est indisponible</h2>
              <p className="mt-1 text-sm text-[#77564f]">
                {query.error instanceof Error ? query.error.message : "Une erreur inattendue est survenue."}
              </p>
              <button
                type="button"
                data-testid="button-retry-afribapay"
                onClick={() => void query.refetch()}
                className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#173d35] px-4 text-sm font-semibold text-white hover:bg-[#24564a]"
              >
                <RefreshCw size={14} /> Réessayer
              </button>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section aria-label="Synthèse par devise" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#718078]">Vue d’ensemble</p>
                <h2 className="mt-1 font-heading text-xl font-semibold tracking-tight">Net par devise</h2>
              </div>
              {report && (
                <p data-testid="text-afribapay-result-count" className="text-xs text-[#718078]">
                  {formatCount(report.total_count)} dépôts dans le résultat filtré
                </p>
              )}
            </div>
            {query.isLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-36 animate-pulse rounded-2xl border border-[#e5e0d5] bg-[#f2efe7]" />
                ))}
              </div>
            ) : report?.summary.length ? (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {report.summary.map((item) => (
                  <article
                    key={item.currency}
                    data-testid={`summary-currency-${item.currency}`}
                    className="relative overflow-hidden rounded-2xl border border-[#dcded2] bg-[#f8f7f1] p-5"
                  >
                    <div className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-xl bg-[#e4ecdf] text-[#36634f]">
                      <CircleDollarSign size={19} />
                    </div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#77857c]">{item.currency}</div>
                    <div data-testid={`text-net-afribapay-summary-${item.currency}`} className="mt-3 font-heading text-[1.7rem] font-semibold tracking-[-0.045em] text-[#173d35]">
                      {item.known_count > 0 ? formatMinor(item.net_minor, item.currency) : "Non disponible"}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[#69766e]">
                      <span>{formatCount(item.deposit_count)} dépôts</span>
                      <span>{formatCount(item.known_count)} avec coûts connus</span>
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-[#e4e3d9] pt-3 text-xs">
                      <span className="text-[#69766e]">Frais réels · {formatMinor(item.fees_minor, item.currency)}</span>
                      {item.unknown_count > 0 ? (
                        <span className="font-semibold text-[#96630b]">{formatCount(item.unknown_count)} inconnus</span>
                      ) : (
                        <span className="font-semibold text-[#397354]">Complet</span>
                      )}
                    </div>
                    {item.unknown_count > 0 && (
                      <p className="mt-2 text-[11px] leading-4 text-[#8b681f]">
                        Dépôts exclus du net : montant facturé ou frais fournisseur manquants.
                      </p>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-[#d4d7cb] bg-[#f7f6ef] px-5 py-7 text-center text-sm text-[#718078]">
                Aucune synthèse pour cette sélection.
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-[#e1dfd5] bg-[#fbfaf6] shadow-[0_8px_24px_-22px_rgba(31,57,48,.4)]">
            <div className="border-b border-[#e6e4da] px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[#76837b]">
                    <SlidersHorizontal size={13} /> Recherche & filtres
                  </div>
                  <p className="mt-1 text-sm text-[#68766e]">Filtrez les dépôts du rapport, puis parcourez le registre.</p>
                </div>
                {filterCount > 0 && (
                  <button
                    type="button"
                    data-testid="button-clear-afribapay-filters"
                    onClick={clearFilters}
                    className="text-xs font-semibold text-[#3a6954] underline decoration-[#a7bbae] underline-offset-4 hover:text-[#173d35]"
                  >
                    Effacer {filterCount} filtre{filterCount > 1 ? "s" : ""}
                  </button>
                )}
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Du
                  <span className="relative block">
                    <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#859188]" />
                    <input
                      type="date"
                      aria-label="Date de début"
                      data-testid="input-afribapay-from"
                      value={filters.from}
                      onChange={(event) => updateFilter("from", event.target.value)}
                      className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] pl-9 pr-2 text-xs text-[#34473e] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                    />
                  </span>
                </label>
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Au
                  <span className="relative block">
                    <CalendarDays size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#859188]" />
                    <input
                      type="date"
                      aria-label="Date de fin"
                      data-testid="input-afribapay-to"
                      value={filters.to}
                      onChange={(event) => updateFilter("to", event.target.value)}
                      className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] pl-9 pr-2 text-xs text-[#34473e] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                    />
                  </span>
                </label>
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Devise
                  <select
                    aria-label="Filtrer par devise"
                    data-testid="select-afribapay-currency"
                    value={filters.currency}
                    onChange={(event) => updateFilter("currency", event.target.value)}
                    className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] px-3 text-xs text-[#34473e] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                  >
                    <option value="">Toutes les devises</option>
                    {report?.filters.currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Pays
                  <select
                    aria-label="Filtrer par pays"
                    data-testid="select-afribapay-country"
                    value={filters.country}
                    onChange={(event) => updateFilter("country", event.target.value)}
                    className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] px-3 text-xs text-[#34473e] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                  >
                    <option value="">Tous les pays</option>
                    {report?.filters.countries.map((country) => <option key={country} value={country}>{country}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Opérateur
                  <select
                    aria-label="Filtrer par opérateur"
                    data-testid="select-afribapay-operator"
                    value={filters.operator}
                    onChange={(event) => updateFilter("operator", event.target.value)}
                    className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] px-3 text-xs text-[#34473e] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                  >
                    <option value="">Tous les opérateurs</option>
                    {report?.filters.operators.map((operator) => <option key={operator} value={operator}>{operator}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-[11px] font-semibold text-[#68766e]">
                  Recherche
                  <span className="relative block">
                    <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#859188]" />
                    <input
                      type="search"
                      aria-label="Rechercher dans les dépôts"
                      data-testid="input-afribapay-search"
                      value={filters.search}
                      onChange={(event) => updateFilter("search", event.target.value)}
                      placeholder="Nom, e-mail, référence…"
                      className="h-10 w-full rounded-lg border border-[#dbded4] bg-[#fffefa] pl-9 pr-3 text-xs text-[#34473e] placeholder:text-[#9ba59d] outline-none focus:border-[#779c84] focus:ring-2 focus:ring-[#779c84]/20"
                    />
                  </span>
                </label>
              </div>
            </div>

            {query.isLoading ? (
              <SkeletonRows />
            ) : query.isError ? (
              <div role="alert" className="px-5 py-10 text-center">
                <p className="text-sm font-semibold text-[#8e493a]">Impossible d’actualiser les dépôts.</p>
                <p className="mt-1 text-xs text-[#718078]">
                  {query.error instanceof Error ? query.error.message : "Vérifiez votre connexion puis réessayez."}
                </p>
                <button
                  type="button"
                  data-testid="button-retry-table-afribapay"
                  onClick={() => void query.refetch()}
                  className="mt-4 rounded-lg border border-[#c9d3c9] px-4 py-2 text-xs font-semibold text-[#315c49] hover:bg-[#edf2e9]"
                >
                  Réessayer
                </button>
              </div>
            ) : !report?.rows.length ? (
              <div className="px-5 py-14 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[#e8ede3] text-[#52735b]">
                  <Download size={20} />
                </div>
                <h3 className="mt-4 font-heading text-lg font-semibold">Aucun dépôt à afficher</h3>
                <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-[#758078]">
                  Aucun dépôt réussi ne correspond à ces critères. Ajustez la période ou effacez les filtres.
                </p>
                {filterCount > 0 && (
                    <button type="button" data-testid="button-clear-afribapay-filters-empty" onClick={clearFilters} className="mt-4 text-sm font-semibold text-[#3a6954] underline underline-offset-4">
                    Effacer les filtres
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[930px] text-left">
                    <thead className="bg-[#f0efe7] text-[10px] font-bold uppercase tracking-[0.14em] text-[#738078]">
                      <tr>
                        <th className="px-5 py-3">Dépôt · utilisateur</th>
                        <th className="px-4 py-3">Pays · opérateur</th>
                        <th className="px-4 py-3">Montant facturé</th>
                        <th className="px-4 py-3">Frais fournisseur</th>
                        <th className="px-4 py-3 text-right">Net calculé</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eeece4]">
                      {report.rows.map((row) => {
                        const net = getNet(row);
                        const unknown = net == null;
                        return (
                          <tr key={row.id} data-testid={`row-afribapay-${row.id}`} className="align-top transition-colors hover:bg-[#f7f7f0]">
                            <td className="px-5 py-4">
                              <div className="font-semibold text-[#293d34]">{row.user_label || "Utilisateur sans nom"}</div>
                              <div className="mt-1 text-xs text-[#7c8980]">{row.user_email || row.phone_number || "Coordonnée indisponible"}</div>
                              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#839087]">
                                <span>{formatDate(row.created_at)}</span>
                                {row.reference && <><span aria-hidden="true">·</span><span className="font-mono">{row.reference}</span></>}
                              </div>
                              {unknown && <div className="mt-2"><UnknownFlag id={row.id} /></div>}
                              {row.provider_fee_total_minor == null && (
                                <button
                                  type="button"
                                  data-testid={`button-afribapay-provider-preview-${row.id}`}
                                  disabled={previewingPaymentId !== null}
                                  onClick={() => void checkProviderStatus(row.id)}
                                  className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-[#cbd8cc] bg-white px-2.5 text-[11px] font-semibold text-[#315c49] hover:bg-[#edf3ea] disabled:cursor-wait disabled:opacity-50"
                                >
                                  <Eye size={13} />
                                  {previewingPaymentId === row.id ? "Vérification…" : "Vérifier chez AfribaPAY"}
                                </button>
                              )}
                            </td>
                            <td className="px-4 py-4">
                              <div className="text-sm font-medium text-[#3e5148]">{row.country || "—"}</div>
                              <div className="mt-1 text-xs text-[#839087]">{row.operator || "Opérateur inconnu"}</div>
                            </td>
                            <td className="px-4 py-4 font-mono text-xs text-[#42564c]">
                              {formatMinor(row.charged_minor, row.currency)}
                            </td>
                            <td className="px-4 py-4 font-mono text-xs text-[#42564c]">
                              {formatMinor(row.provider_fee_total_minor, row.currency)}
                              {row.provider_fee_total_minor != null && (
                                <div className="mt-1 font-sans text-[10px] text-[#8c978f]">
                                  {row.provider_fee_minor != null ? `Frais ${formatMinor(row.provider_fee_minor, row.currency)}` : "Frais détaillés indisponibles"}
                                  {row.provider_tax_minor != null && ` · Taxe ${formatMinor(row.provider_tax_minor, row.currency)}`}
                                </div>
                              )}
                            </td>
                            <td className="px-5 py-4 text-right">
                              {net == null ? (
                                <span className="text-xs font-semibold text-[#946611]">Non calculable</span>
                              ) : (
                                <span className="inline-flex items-center justify-end gap-1 font-mono text-sm font-semibold text-[#2f664c]">
                                  <ArrowDownRight size={14} /> {formatMinor(net, row.currency)}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="divide-y divide-[#eeece4] md:hidden">
                  {report.rows.map((row) => {
                    const net = getNet(row);
                    return (
                      <article key={row.id} data-testid={`card-afribapay-${row.id}`} className="space-y-3 px-4 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-[#293d34]">{row.user_label || "Utilisateur sans nom"}</div>
                            <div className="mt-1 truncate text-xs text-[#7c8980]">{row.user_email || row.phone_number || "Coordonnée indisponible"}</div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-[#87928a]">{row.currency}</div>
                            <div className="mt-1 font-mono text-sm font-semibold text-[#2f664c]">
                              {net == null ? "Non calculable" : formatMinor(net, row.currency)}
                            </div>
                          </div>
                        </div>
                        {net == null && <UnknownFlag id={row.id} />}
                        <div className="grid grid-cols-2 gap-3 rounded-xl bg-[#f2f1e9] p-3 text-xs">
                          <div><span className="block text-[#839087]">Facturé</span><span className="mt-1 block font-mono text-[#43564c]">{formatMinor(row.charged_minor, row.currency)}</span></div>
                          <div><span className="block text-[#839087]">Frais fournisseur</span><span className="mt-1 block font-mono text-[#43564c]">{formatMinor(row.provider_fee_total_minor, row.currency)}</span></div>
                          <div><span className="block text-[#839087]">Pays · opérateur</span><span className="mt-1 block text-[#43564c]">{row.country || "—"} · {row.operator || "—"}</span></div>
                          <div><span className="block text-[#839087]">Date</span><span className="mt-1 block text-[#43564c]">{formatDate(row.created_at)}</span></div>
                        </div>
                        {row.reference && <div className="truncate font-mono text-[11px] text-[#839087]">Réf. {row.reference}</div>}
                        {row.provider_fee_total_minor == null && (
                          <button
                            type="button"
                            data-testid={`button-afribapay-provider-preview-mobile-${row.id}`}
                            disabled={previewingPaymentId !== null}
                            onClick={() => void checkProviderStatus(row.id)}
                            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#cbd8cc] bg-white px-3 text-xs font-semibold text-[#315c49] hover:bg-[#edf3ea] disabled:cursor-wait disabled:opacity-50"
                          >
                            <Eye size={14} />
                            {previewingPaymentId === row.id ? "Vérification…" : "Vérifier chez AfribaPAY"}
                          </button>
                        )}
                      </article>
                    );
                  })}
                </div>
                <footer className="flex flex-col gap-3 border-t border-[#e6e4da] bg-[#f6f5ee] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <p className="text-xs text-[#758078]" aria-live="polite">
                    {report.total_count === 0
                      ? "Aucun dépôt"
                      : `${formatCount(offset + 1)}–${formatCount(Math.min(offset + report.rows.length, report.total_count))} sur ${formatCount(report.total_count)}`}
                    {query.isFetching && <span className="ml-2 text-[#52735b]">Mise à jour…</span>}
                  </p>
                  <div className="flex items-center justify-between gap-2 sm:justify-end">
                    <button
                      type="button"
                      data-testid="button-prev-afribapay-page"
                      disabled={offset === 0 || query.isFetching}
                      onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#d7dbd1] bg-[#fffefa] px-3 text-xs font-semibold text-[#4a5b52] hover:bg-[#edf1e9] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ArrowLeft size={14} /> Précédent
                    </button>
                    <span className="min-w-[4.5rem] text-center text-xs font-semibold tabular-nums text-[#647269]">
                      {currentPage} / {pageCount}
                    </span>
                    <button
                      type="button"
                      data-testid="button-next-afribapay-page"
                      disabled={!report || offset + PAGE_SIZE >= report.total_count || query.isFetching}
                      onClick={() => setOffset((current) => current + PAGE_SIZE)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-[#d7dbd1] bg-[#fffefa] px-3 text-xs font-semibold text-[#4a5b52] hover:bg-[#edf1e9] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Suivant <ArrowRight size={14} />
                    </button>
                  </div>
                </footer>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}