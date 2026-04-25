import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Send, Image as ImageIcon, X, Loader2, Clock, Headphones } from "lucide-react";
import { toast } from "sonner";
import {
  fetchMyThread,
  sendMyMessage,
  fileToCompressedDataUrl,
  markUserRead,
  type SupportMessage,
} from "@/lib/support";
import { SupportImage } from "@/components/SupportImage";

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};

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
      // Mark as read whenever we view the conversation
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

      <Card className="flex flex-col h-[70vh]">
        {/* Messages */}
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
                        Support BUZZ BOOST
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

        {/* Composer */}
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
