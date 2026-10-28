import { authedFetch, AUTH_ENDING_EVENT, AUTH_CHANGED_EVENT } from "@/lib/authFetch";

const SCRIPT_ID = "buzzbooster-sabito-widget";
const SABITO_ORIGIN = "https://sabito.bizconnectacademy.com";
const VISITOR_PROJECT_ID = "b5e20880-c403-412e-a24e-914851872294";

interface SabitoWidgetApi {
  logout: () => void;
  login: () => void;
  open: () => void;
  close: () => void;
}

declare global {
  interface Window {
    __BUZZBOOSTER_PRERENDER__?: boolean;
    SabitoWidget?: SabitoWidgetApi;
    SabitoWidgetSession?: (options: { signal: AbortSignal }) => Promise<Response>;
  }
}

// Only account identity is held here, never a Buzz Booster or Sabito token.
let identity: string | undefined;
let ending = false;
let reloading = false;
let widgetEnabled = true;
let widgetPaused = false;
const authChannel = typeof window !== "undefined" && "BroadcastChannel" in window
  ? new BroadcastChannel("buzzbooster-sabito-auth")
  : undefined;

function reloadForIdentityChange(): void {
  if (reloading) return;
  reloading = true;
  endSabitoSession();
  window.location.reload();
}

function blockSession(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 401 }));
}

function applyWidgetVisibility(): void {
  document.querySelectorAll<HTMLElement>("[data-sabito-widget]").forEach(host => {
    host.hidden = !widgetEnabled;
    if (widgetEnabled) host.style.removeProperty("display");
    else host.style.setProperty("display", "none", "important");
  });
}

/** Pause without removing the SDK host: reactivation must not reload user forms. */
export function disableSabitoWidget(): void {
  const changed = widgetEnabled;
  widgetEnabled = false;
  widgetPaused = true;
  try {
    if (changed) window.SabitoWidget?.logout();
  } finally {
    applyWidgetVisibility();
  }
}

function resumeWidget(): void {
  if (widgetPaused && window.SabitoWidget) {
    window.SabitoWidget.login();
    widgetPaused = false;
  }
  applyWidgetVisibility();
}

/** Remove the private iframe immediately, including while sign-out is pending. */
export function endSabitoSession(): void {
  ending = true;
  window.SabitoWidgetSession = blockSession;
  try {
    window.SabitoWidget?.logout();
  } finally {
    document.querySelectorAll("[data-sabito-widget]").forEach((host) => host.remove());
  }
}

async function memberSession({ signal }: { signal: AbortSignal }): Promise<Response> {
  if (!widgetEnabled) return new Response(null, { status: 503 });
  if (ending) return blockSession();
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  // The official loader uses this same CSRF meta convention. No token is invented.
  const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  return authedFetch("/api/sabito/session", {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: "{}",
    signal,
    redirect: "error",
    cache: "no-store",
  });
}

/**
 * One official loader per document, irrespective of React StrictMode or SPA routes.
 * The loader captures its mode and exposes no destroy method. A full reload at an
 * identity boundary is therefore intentional: no visitor config, iframe, old
 * event listeners, pending response, or private conversation crosses accounts.
 */
export function syncSabitoWidget(userId: string | null): void {
  if (window.__BUZZBOOSTER_PRERENDER__) return;
  const nextIdentity = userId === null ? "visitor" : `member:${userId}`;
  if (reloading) return;
  if (identity !== undefined && (identity !== nextIdentity || ending)) {
    authChannel?.postMessage("changed");
    reloadForIdentityChange();
    return;
  }
  widgetEnabled = true;
  if (document.getElementById(SCRIPT_ID)) {
    resumeWidget();
    return;
  }

  identity = nextIdentity;
  ending = false;
  if (userId !== null) window.SabitoWidgetSession = memberSession;
  else delete window.SabitoWidgetSession;

  const script = document.createElement("script");
  script.id = SCRIPT_ID;
  script.defer = true;
  script.src = `${SABITO_ORIGIN}/widget/sabito-chat.js`;
  script.dataset.apiUrl = SABITO_ORIGIN;
  script.dataset.title = "Sabito AI";
  script.dataset.language = "fr";
  script.dataset.primaryColor = "#4f46e5";
  script.dataset.position = "right";
  script.dataset.productCode = "buzzbooster";
  if (userId === null) {
    script.dataset.projectId = VISITOR_PROJECT_ID;
  } else {
    // Never set projectId in member mode: identity comes from our backend only.
    script.dataset.sessionUrl = "/api/sabito/session";
  }
  script.addEventListener("load", () => {
    if (ending || reloading) endSabitoSession();
    else if (!widgetEnabled) {
      window.SabitoWidget?.logout();
      applyWidgetVisibility();
    } else resumeWidget();
  }, { once: true });
  script.addEventListener("error", () => {
    // Explicit failure without exposing credentials or replacing Sabito's UI.
    console.error("[Sabito] Le widget officiel n’a pas pu être chargé.");
  }, { once: true });
  document.body.appendChild(script);
}

// Module-level listeners survive React effect replays without being duplicated.
if (typeof window !== "undefined") {
  window.addEventListener(AUTH_ENDING_EVENT, () => {
    endSabitoSession();
    authChannel?.postMessage("ending");
  });
  window.addEventListener(AUTH_CHANGED_EVENT, () => {
    authChannel?.postMessage("changed");
  });
  if (authChannel) {
    authChannel.onmessage = ({ data }) => {
      // No IDs, session tokens, or conversations are sent between tabs.
      if (data === "ending") endSabitoSession();
      else if (data === "changed") reloadForIdentityChange();
    };
  }
  window.addEventListener("pagehide", endSabitoSession);
  // A back/forward-cache restoration must not resurrect the previous account.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      endSabitoSession();
      window.location.reload();
    }
  });
}
