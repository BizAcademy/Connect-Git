import type { SabitoJob, SabitoResult } from "../lib/sabito-handlers";
export function startSabitoBackend(options: {
  handlers: Record<string, (job: SabitoJob) => Promise<SabitoResult>>;
  signal?: AbortSignal;
  onError?: (code: string) => void;
}): Promise<void>;
