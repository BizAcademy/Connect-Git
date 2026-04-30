import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, Image as ImageIcon, X, Loader2, Clock, Headphones, TicketCheck, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import {
  fetchMyThread,
  sendMyMessage,
  fileToCompressedDataUrl,
  markUserRead,
  type SupportMessage,
} from "@/lib/support";
import { fetchMyTickets, markTicketRepliesSeen, type Ticket } from "@/lib/tickets";
import { SupportImage } from "@/components/SupportImage";
import { supabase } from "@/integrations/supabase/client";

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

const ACTION_LABELS: Record<string, string> = {
  cancel: "Annulation",
  refund: "Remboursement",
  speed_up: "Accélération",
  other: "Autre demande",
};

const STATUS_STYLES: Record<string, string> = {
  open: "bg-yellow-100 text-yellow-800 border-yellow-300",
  in_progress: "bg-blue-100 text-blue-800 border-blue-300",
  resolved: "bg-green-100 text-green-800 border-green-300",
  closed: "bg-gray-100 text-gray-700 border-gray-300",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Ouvert",
  in_progress: "En cours",
  resolved: "Résolu",
  closed: "Fermé",
};

function TicketCard({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(ticket.admin_response ? true : false);
  const hasReply = !!ticket.admin_response;
  const statusStyle = STATUS_STYLES[ticket.status] || STATUS_STYLES.closed;
  const statusLabel = STATUS_LABELS[ticket.status] || ticket.status;

  return (
    <div className={`border rounded-lg overflow-hidden ${hasReply && ticket.status !== "closed" ? "ring-2 ring-primary/30" : ""}`}>
      <button
        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-card hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-xs font-bold text-primary shrink-0">{ticket.short_code}</span>
          <span
            className={`inline-flex text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${statusStyle} shrink-0`}
          >
            {statusLabel}
          </span>
          <span className="text-xs text-muted-foreground truncate">
            {ACTION_LABELS[ticket.action_type] || ticket.action_type}
            {ticket.order_external_id ? ` · #${ticket.order_external_id}` : ""}
          </span>
          {hasReply && (
            <span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30 shrink-0">
              Réponse
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-muted-foreground">{formatTime(ticket.ts)}</span>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      {open && (
        <div className="border-t px-3 py-3 space-y-2 bg-muted/20">
          <div className="bg-white border rounded-md p-3">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Votre message</div>
            <p className="text-sm whitespace-pre-wrap text-foreground">{ticket.message}</p>
          </div>

          {hasReply ? (
            <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
              <div className="text-[10px] text-blue-900 uppercase tracking-wide font-medium mb-1">
                Réponse du support
              </div>
              <p className="text-sm whitespace-pre-wrap text-blue-900">{ticket.admin_response}</p>
              {ticket.resolved_at && (
                <p className="text-[10px] text-blue-600 mt-1.5">
                  Traité le {new Date(ticket.resolved_at).toLocaleString("fr-FR")}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-2">
              En attente de réponse du support — délai habituel : 24h–72h.
            </p>
          )}

          {ticket.cancel_executed && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-md p-2 text-xs text-emerald-800">
              ✓ Commande annulée
              {ticket.refunded_amount_fcfa != null
                ? ` — ${ticket.refunded_amount_fcfa.toLocaleString("fr-FR")} FCFA remboursés sur votre solde`
                : " et remboursement effectué"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MyTickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const refresh = async (silent = false) => {
    try {
      const list = await fetchMyTickets();
      setTickets(list);
      // Mark all replied tickets as seen so the nav badge clears
      const repliedIds = list.filter((t) => t.admin_response).map((t) => t.id);
      if (repliedIds.length) markTicketRepliesSeen(repliedIds);
      if (!silent) setOpen(list.length > 0);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(true), 10000);

    const channel = supabase
      .channel("user-my-tickets")
      .on(
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "tickets" },
        () => { void refresh(true); },
      )
      .subscribe();

    return () => {
      clearInterval(id);
      void supabase.removeChannel(channel);
    };
  }, []);

  if (loading) return null;
  if (tickets.length === 0) return null;

  const hasUnread = tickets.some((t) => t.admin_response && t.status !== "closed");

  return (
    <div className="mb-4">
      <button
        className="w-full flex items-center justify-between gap-2 py-2 text-sm font-semibold"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-2">
          <TicketCheck size={16} className="text-primary" />
          Mes demandes de support
          {hasUnread && (
            <span className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground">
              Réponse !
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <div className="space-y-2 mt-1">
          {tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </div>
  );
}

const Support = () => {
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [text, setText] = useState("");
  const [imageData, setImageData] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await fetchMyThread();
      setMessages(r.messages);
      markUserRead().catch(() => {});
    } catch (e: any) {
      if (!silent) toast.error(e.message || "Erreur de chargement");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 8000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("Seules les images sont acceptées");
      return;
    }
    try {
      const url = await fileToCompressedDataUrl(f);
      setImageData(url);
    } catch (err: any) {
      toast.error(err.message || "Image invalide");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onSend = async () => {
    if (!text.trim() && !imageData) return;
    setSending(true);
    try {
      const msg = await sendMyMessage(text.trim(), imageData || undefined);
      setMessages((prev) => [...prev, msg]);
      setText("");
      setImageData(null);
    } catch (e: any) {
      toast.error(e.message || "Erreur d'envoi");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Headphones size={20} className="text-primary" />
          Support
        </h2>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
          <Clock size={12} />
          Vos messages sont privés et conservés pendant 7 jours, puis supprimés automatiquement.
        </p>
      </div>

      <MyTickets />

      <Card className="flex flex-col h-[70vh]">
        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-muted/20">
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="animate-spin text-primary" size={28} />
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground">
              <Headphones size={42} className="mb-3 opacity-40" />
              <p className="text-sm">Bonjour, comment pouvons-nous vous aider ?</p>
              <p className="text-xs mt-1">Envoyez votre premier message ci-dessous.</p>
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.sender === "user";
              return (
                <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 ${
                    mine ? "bg-primary text-primary-foreground rounded-br-sm" : "bg-card border rounded-bl-sm"
                  }`}>
                    {!mine && (
                      <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5 text-primary">
                        Support BUZZ BOOSTER
                      </p>
                    )}
                    {m.image_filename && (
                      <div className="mb-1.5 -mx-1">
                        <SupportImage filename={m.image_filename} />
                      </div>
                    )}
                    {m.text && <p className="text-sm whitespace-pre-wrap break-words">{m.text}</p>}
                    <p className={`text-[10px] mt-1 ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {formatTime(m.ts)}
                    </p>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        <CardContent className="p-3 border-t bg-card">
          {imageData && (
            <div className="mb-2 relative inline-block">
              <img src={imageData} alt="aperçu" className="h-20 rounded border" />
              <button
                onClick={() => setImageData(null)}
                className="absolute -top-2 -right-2 bg-red-600 text-white rounded-full p-0.5"
                aria-label="Supprimer l'image"
              >
                <X size={12} />
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickFile} />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
              title="Joindre une image"
            >
              <ImageIcon size={16} />
            </Button>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
              placeholder="Écrivez votre message…"
              rows={1}
              className="flex-1 resize-none rounded-md border px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 max-h-32"
            />
            <Button onClick={onSend} disabled={sending || (!text.trim() && !imageData)}>
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default Support;
