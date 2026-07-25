/**
 * Préchargement des images critiques.
 *
 * - preloadImage : téléchargement immédiat en priorité haute — pour l'image
 *   principale de la page d'entrée (LCP), démarre dès l'évaluation du bundle,
 *   avant même le premier rendu React.
 * - prefetchImage : mise en cache en tâche de fond (priorité minimale, quand
 *   le navigateur est inactif) — pour les images des pages suivantes, afin
 *   que la navigation les affiche instantanément.
 */

const seen = new Set<string>();

function addLink(rel: "preload" | "prefetch", href: string): void {
  if (typeof document === "undefined") return;
  const key = `${rel}:${href}`;
  if (seen.has(key)) return;
  seen.add(key);
  const link = document.createElement("link");
  link.rel = rel;
  link.as = "image";
  link.href = href;
  if (rel === "preload") link.setAttribute("fetchpriority", "high");
  document.head.appendChild(link);
}

/** Charge l'image immédiatement, en priorité haute (image de la page courante). */
export function preloadImage(url: string): void {
  addLink("preload", url);
}

/** Met l'image en cache dès que le navigateur est inactif (pages suivantes). */
export function prefetchImage(url: string): void {
  if (typeof document === "undefined") return;
  const run = () => addLink("prefetch", url);
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1500);
  }
}
