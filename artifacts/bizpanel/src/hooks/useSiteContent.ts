import { useEffect, useState } from "react";

type ContentMap = Record<string, string>;

let cache: ContentMap | null = null;
const listeners: Array<(map: ContentMap) => void> = [];

async function loadContent(): Promise<ContentMap> {
  if (cache) return cache;
  const response = await fetch("/api/site-content");
  if (!response.ok) throw new Error("Contenu indisponible");
  const json = await response.json() as { content?: Array<{ key: string; value: string }> };
  const data = json.content || [];
  const map: ContentMap = {};
  (data || []).forEach((row) => { map[row.key] = row.value; });
  cache = map;
  listeners.forEach((fn) => fn(map));
  return map;
}

export function useSiteContent() {
  const [content, setContent] = useState<ContentMap>(cache || {});
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (cache) { setContent(cache); setLoading(false); return; }
    loadContent()
      .then((map) => setContent(map))
      .catch((error) => console.error("[site-content] load failed", error))
      .finally(() => setLoading(false));
  }, []);

  const get = (key: string, fallback = "") => content[key] ?? fallback;

  return { content, get, loading };
}

export function invalidateSiteContentCache() {
  cache = null;
}
