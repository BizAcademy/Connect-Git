/**
 * Messages de page (remplace les toasts flottants sonner / shadcn).
 *
 * Affiche un bandeau pleine largeur EN HAUT de la page :
 *   - vert  = action validée   (toast.success)
 *   - rouge = action refusée   (toast.error)
 *   - ambre = avertissement    (toast.warning)
 *   - gris  = information      (toast.info)
 *
 * API compatible avec les deux anciens systèmes pour ne pas réécrire les
 * appels existants :
 *   - sonner :  toast.success("...") / toast.error("...", { description })
 *   - shadcn :  toast({ title, description, variant }) + useToast()
 */
import { isValidElement, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

type Kind = "success" | "error" | "info" | "warning";

export type ToastOptions = {
  duration?: number;
  description?: ReactNode;
  [key: string]: unknown; // tolère les options sonner non utilisées
};

type Msg = {
  id: number;
  kind: Kind;
  text: ReactNode;
  description?: ReactNode;
};

let nextId = 1;
let messages: Msg[] = [];
const subscribers = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  subscribers.forEach((fn) => fn());
}

function dismiss(id?: number) {
  if (id === undefined) {
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    messages = [];
  } else {
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
    messages = messages.filter((m) => m.id !== id);
  }
  emit();
}

function push(kind: Kind, text: ReactNode, opts?: ToastOptions): number {
  const duration = opts?.duration ?? (kind === "error" ? 7000 : 5000);

  // Dédoublonnage : même texte + même type déjà affiché → on relance juste le minuteur.
  if (typeof text === "string") {
    const dup = messages.find((m) => m.kind === kind && m.text === text);
    if (dup) {
      const t = timers.get(dup.id);
      if (t) clearTimeout(t);
      timers.set(dup.id, setTimeout(() => dismiss(dup.id), duration));
      return dup.id;
    }
  }

  const id = nextId++;
  messages = [...messages, { id, kind, text, description: opts?.description }];

  // Maximum 3 bandeaux empilés : on retire le plus ancien.
  if (messages.length > 3) {
    const oldest = messages[0];
    const t = timers.get(oldest.id);
    if (t) clearTimeout(t);
    timers.delete(oldest.id);
    messages = messages.slice(1);
  }

  timers.set(id, setTimeout(() => dismiss(id), duration));
  emit();
  return id;
}

/* ── Compatibilité ancien appel shadcn : toast({ title, description, variant }) ── */
type LegacyShadcnArgs = {
  title?: ReactNode;
  description?: ReactNode;
  variant?: "default" | "destructive";
};

function base(arg: ReactNode | LegacyShadcnArgs, opts?: ToastOptions): number {
  if (
    arg &&
    typeof arg === "object" &&
    !isValidElement(arg) &&
    !Array.isArray(arg) &&
    ("title" in (arg as object) || "description" in (arg as object) || "variant" in (arg as object))
  ) {
    const a = arg as LegacyShadcnArgs;
    const kind: Kind = a.variant === "destructive" ? "error" : "success";
    const text = a.title ?? a.description ?? "";
    const description = a.title ? a.description : undefined;
    return push(kind, text, { description });
  }
  return push("info", arg as ReactNode, opts);
}

export const toast = Object.assign(base, {
  success: (text: ReactNode, opts?: ToastOptions) => push("success", text, opts),
  error: (text: ReactNode, opts?: ToastOptions) => push("error", text, opts),
  warning: (text: ReactNode, opts?: ToastOptions) => push("warning", text, opts),
  info: (text: ReactNode, opts?: ToastOptions) => push("info", text, opts),
  message: (text: ReactNode, opts?: ToastOptions) => push("info", text, opts),
  dismiss,
});

/** Compatibilité avec l'ancien hook shadcn `useToast()`. */
export function useToast() {
  return { toast, dismiss, toasts: [] as Msg[] };
}

/* ────────────────────────── Affichage ────────────────────────── */

const STYLES: Record<Kind, { bg: string; Icon: typeof CheckCircle2 }> = {
  success: { bg: "bg-green-600", Icon: CheckCircle2 },
  error: { bg: "bg-red-600", Icon: XCircle },
  warning: { bg: "bg-amber-500", Icon: AlertTriangle },
  info: { bg: "bg-slate-700", Icon: Info },
};

/** À monter UNE fois (App.tsx). Bandeaux pleine largeur en haut de la page. */
export function PageMessages() {
  const [list, setList] = useState<Msg[]>(messages);

  useEffect(() => {
    const fn = () => setList(messages);
    subscribers.add(fn);
    return () => {
      subscribers.delete(fn);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[200]" role="status" aria-live="polite">
      <style>{`@keyframes bb-banner-in{from{transform:translateY(-100%);opacity:.3}to{transform:translateY(0);opacity:1}}`}</style>
      {list.map((m) => {
        const s = STYLES[m.kind];
        return (
          <div
            key={m.id}
            style={{ animation: "bb-banner-in .25s ease-out" }}
            className={`${s.bg} text-white shadow-md border-b border-black/10`}
          >
            <div className="max-w-5xl mx-auto flex items-start gap-2.5 px-4 py-2.5 sm:py-3">
              <s.Icon size={18} className="shrink-0 mt-0.5" aria-hidden />
              <div className="min-w-0 flex-1 text-sm font-semibold leading-snug break-words">
                {m.text}
                {m.description != null && m.description !== "" && (
                  <div className="font-normal text-[13px] opacity-90 mt-0.5">{m.description}</div>
                )}
              </div>
              <button
                onClick={() => dismiss(m.id)}
                aria-label="Fermer le message"
                className="shrink-0 p-0.5 opacity-80 hover:opacity-100 transition-opacity"
              >
                <X size={16} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
