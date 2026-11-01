/** Passenger can execute index.mjs directly, without npm's start script. */
export function shouldStartSabito(nodeEnv: string | undefined, previewProxyEnabled: boolean): boolean {
  return !previewProxyEnabled && nodeEnv !== "development" && nodeEnv !== "test";
}
