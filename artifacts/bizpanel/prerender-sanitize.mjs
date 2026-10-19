/**
 * Public HTML must not include a widget initialized with the prerender
 * browser's guest identity. Keep SEO content and the app entry unchanged.
 * Self-contained so Puppeteer can evaluate this function in the page.
 */
export function serializePublicDocument(document) {
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll("#buzzbooster-sabito-widget, [data-sabito-widget]").forEach(node => node.remove());
  for (const node of root.querySelectorAll("script[src], iframe[src]")) {
    try {
      const url = new URL(node.getAttribute("src"), document.baseURI);
      if (
        url.origin === "https://sabito.bizconnectacademy.com" &&
        (url.pathname === "/widget/sabito-chat.js" || url.pathname === "/widget/chat")
      ) node.remove();
    } catch {
      // Preserve unrelated markup; only the known runtime widget is excluded.
    }
  }
  return "<!DOCTYPE html>\n" + root.outerHTML;
}
