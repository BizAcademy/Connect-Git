import { Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface InvoiceData {
  number: string;             // e.g. "BP-2026-000123"
  date: string;               // ISO string
  type: "deposit" | "order" | "refund";
  customer: { name?: string; email?: string };
  amount: number;             // FCFA
  status: string;
  details: { label: string; value: string }[];
  note?: string;
}

const typeLabel: Record<InvoiceData["type"], string> = {
  deposit: "Reçu de dépôt",
  order: "Facture de commande",
  refund: "Avis de remboursement",
};

export function InvoiceModal({ data, onClose }: { data: InvoiceData; onClose: () => void }) {
  const handlePrint = () => {
    window.print();
  };

  const isCredit = data.type !== "order";
  const sign = isCredit ? "+" : "−";
  const color = isCredit ? "text-green-700" : "text-red-700";

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-start md:items-center justify-center p-2 md:p-6 overflow-y-auto print:bg-white print:p-0 print:block"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-2xl w-full max-w-2xl my-4 print:shadow-none print:rounded-none print:max-w-none print:my-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar (hidden on print) */}
        <div className="flex items-center justify-between p-3 border-b print:hidden">
          <h3 className="font-semibold text-sm">{typeLabel[data.type]}</h3>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={handlePrint}>
              <Printer size={14} className="mr-1" /> Imprimer
            </Button>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-md hover:bg-muted flex items-center justify-center"
              aria-label="Fermer"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Printable area */}
        <div id="invoice-printable" className="p-6 md:p-10 text-sm text-black">
          <div className="flex items-start justify-between mb-8">
            <div>
              <p className="font-heading text-2xl font-bold">
                <span style={{ color: "hsl(217, 91%, 50%)" }}>BUZZ</span>{" "}
                <span style={{ color: "hsl(190, 75%, 45%)" }}>BOOSTER</span>
              </p>
              <p className="text-xs text-gray-600 mt-1">Services SMM &amp; recharges</p>
            </div>
            <div className="text-right">
              <p className="font-bold text-lg">{typeLabel[data.type]}</p>
              <p className="text-xs text-gray-600 mt-1">N° {data.number}</p>
              <p className="text-xs text-gray-600">
                {new Date(data.date).toLocaleString("fr-FR", {
                  day: "2-digit", month: "2-digit", year: "numeric",
                  hour: "2-digit", minute: "2-digit",
                })}
              </p>
            </div>
          </div>

          {/* Customer */}
          <div className="mb-6">
            <p className="text-[11px] uppercase text-gray-500 font-semibold">Client</p>
            <p className="font-medium">{data.customer.name || "—"}</p>
            {data.customer.email && (
              <p className="text-xs text-gray-600">{data.customer.email}</p>
            )}
          </div>

          {/* Details */}
          <div className="border rounded-md overflow-hidden mb-6">
            <table className="w-full text-xs">
              <tbody>
                {data.details.map((d, i) => (
                  <tr key={i} className={i % 2 === 0 ? "bg-gray-50" : ""}>
                    <td className="px-3 py-2 text-gray-600 w-1/3">{d.label}</td>
                    <td className="px-3 py-2 font-medium break-all">{d.value}</td>
                  </tr>
                ))}
                <tr className="bg-gray-50">
                  <td className="px-3 py-2 text-gray-600">Statut</td>
                  <td className="px-3 py-2 font-medium capitalize">{data.status}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Amount */}
          <div className="border-t-2 border-black pt-3 flex items-end justify-between">
            <p className="text-xs text-gray-600">
              Montant {isCredit ? "crédité" : "débité"}
            </p>
            <p className={`font-bold text-2xl ${color}`}>
              {sign}
              {Math.round(data.amount).toLocaleString("fr-FR")} FCFA
            </p>
          </div>

          {data.note && (
            <p className="mt-6 text-[11px] text-gray-600 italic border-t pt-3">{data.note}</p>
          )}

          <p className="mt-10 text-center text-[10px] text-gray-500">
            Document généré automatiquement par BUZZ BOOSTER — conservez-le pour vos archives.
          </p>
        </div>
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #invoice-printable, #invoice-printable * { visibility: visible !important; }
          #invoice-printable {
            position: absolute !important;
            left: 0; top: 0; width: 100%;
          }
        }
      `}</style>
    </div>
  );
}
