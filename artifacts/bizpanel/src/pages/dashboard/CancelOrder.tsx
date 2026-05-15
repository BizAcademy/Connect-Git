import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Send, Info, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { createTicket, type TicketActionType } from "@/lib/tickets";

const ACTION_LABELS: Record<TicketActionType, string> = {
  cancel: "Annuler ma commande",
  refund: "Demander un remboursement",
  speed_up: "Accélérer la livraison",
  other: "Autre demande",
};

function genTempCode(): string {
  // Local placeholder used inside the message only — the real ticket number
  // is assigned by the server once the request is saved. We still embed
  // something so the user has a reference to quote even before submitting.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `T-${s}`;
}

export default function CancelOrder() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  // Routed by Supabase order primary key (local id), NOT external_order_id —
  // external IDs can collide across SMM providers, which would let an admin
  // act on the wrong order. The server also re-validates ownership.
  const { orderId } = useParams();

  const [order, setOrder] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<TicketActionType>("cancel");
  const [submitting, setSubmitting] = useState(false);
  const [tempCode] = useState(() => genTempCode());
  const [userEdited, setUserEdited] = useState(false);

  const defaultMessage = useMemo(() => {
    const verb =
      action === "cancel" ? "annuler ma commande" :
      action === "refund" ? "obtenir un remboursement pour ma commande" :
      action === "speed_up" ? "accélérer la livraison de ma commande" :
      "demander une intervention sur ma commande";
    const ref = order?.external_order_id ? ` n°${order.external_order_id}` : "";
    return [
      `Numéro de ticket : ${tempCode}`,
      ``,
      `Bonjour, je souhaite ${verb}${ref}.`,
      ``,
      `Le traitement de cette demande peut prendre entre 24h et 72h. Merci de votre patience.`,
    ].join("\n");
  }, [action, order, tempCode]);

  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    if (!user || !orderId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .eq("user_id", user.id)
        .limit(1);
      if (cancelled) return;
      setOrder((data && data[0]) || null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user, orderId]);

  // Keep the textarea in sync with the action dropdown until the user types
  useEffect(() => {
    if (!userEdited) setMessage(defaultMessage);
  }, [defaultMessage, userEdited]);

  const onSubmit = async () => {
    if (!order) return;
    if (!message.trim()) {
      toast({
        title: "Message requis",
        description: "Veuillez écrire un message.",
        variant: "destructive",
      });
      return;
    }
    setSubmitting(true);
    try {
      // Send only the local order id — the server pulls the canonical
      // external_order_id, provider and service_name from the DB so the
      // client cannot tamper with what the admin sees on the ticket.
      const t = await createTicket({
        order_local_id: order.id,
        action_type: action,
        message,
      });
      toast({
        title: "Ticket envoyé",
        description: `Demande enregistrée sous le numéro ${t.short_code}. Délai de traitement : 24h à 72h.`,
      });
      navigate("/dashboard/orders");
    } catch (err: any) {
      toast({
        title: "Échec de l'envoi",
        description: err?.message || "Erreur inconnue",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => navigate("/dashboard/orders")}>
          <ArrowLeft size={14} className="mr-1" /> Retour aux commandes
        </Button>
      </div>

      <div>
        <h2 className="text-xl font-bold font-heading">Demande sur une commande</h2>
        <p className="text-sm text-muted-foreground">
          Choisissez l'action souhaitée et décrivez votre demande. Notre équipe vous répondra sous 24h à 72h.
        </p>
      </div>

      <div className="rounded-md border bg-amber-50 border-amber-200 text-amber-900 p-3 text-xs flex gap-2 items-start">
        <Info size={14} className="mt-0.5 shrink-0" />
        <p>
          <strong>Important :</strong> envoyer ce message <strong>n'annule pas</strong> votre
          commande immédiatement. Notre équipe l'examinera puis appliquera l'action choisie.
          Le délai de traitement est de <strong>24h à 72h</strong>. Pensez à mentionner le numéro
          de ticket ci-dessous dans toute correspondance ultérieure.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin" />
        </div>
      ) : !order ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Commande introuvable.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Commande #{order.external_order_id || order.id.slice(0, 8)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-muted-foreground space-y-1">
              <div><strong className="text-foreground">Service :</strong> {order.service_name}</div>
              <div className="break-all">
                <strong className="text-foreground">Lien :</strong> {order.link}
              </div>
              <div>
                <strong className="text-foreground">Quantité :</strong>{" "}
                {Number(order.quantity).toLocaleString()}
              </div>
              <div>
                <strong className="text-foreground">Prix :</strong>{" "}
                {Number(order.price).toLocaleString()}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Action souhaitée</Label>
              <Select
                value={action}
                onValueChange={(v) => { setAction(v as TicketActionType); setUserEdited(false); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACTION_LABELS) as TicketActionType[]).map((k) => (
                    <SelectItem key={k} value={k}>{ACTION_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Votre message</Label>
              <Textarea
                rows={9}
                value={message}
                onChange={(e) => { setMessage(e.target.value); setUserEdited(true); }}
                placeholder="Décrivez votre demande..."
              />
              <p className="text-[11px] text-muted-foreground">
                Le numéro <code className="bg-muted px-1 rounded">{tempCode}</code> est votre
                identifiant temporaire — un numéro définitif vous sera attribué après l'envoi.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => navigate("/dashboard/orders")}>
                Retour
              </Button>
              <Button onClick={onSubmit} disabled={submitting}>
                {submitting
                  ? <Loader2 className="animate-spin mr-1" size={14} />
                  : <Send size={14} className="mr-1" />}
                Envoyer la demande
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
