import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type ContentMap = Record<string, string>;

let cache: ContentMap | null = null;
const listeners: Array<(map: ContentMap) => void> = [];

async function loadContent(): Promise<ContentMap> {
  if (cache) return cache;
  const { data } = await supabase.from("site_content").select("key, value");
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
    loadContent().then((map) => { setContent(map); setLoading(false); });
  }, []);

  const get = (key: string, fallback = "") => content[key] ?? fallback;

  return { content, get, loading };
}

export function invalidateSiteContentCache() {
  cache = null;
}
