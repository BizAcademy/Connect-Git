---
name: Preview auth request interception
description: Avoid accidental live local API calls while mocking auth in browser checks against the proxied preview.
---

When comparing browser request origins for auth interception on a default-port preview, normalize the target using `new URL(target).origin` rather than comparing a literal URL containing `:80`.

**Why:** The browser canonicalizes the default HTTP port out of `URL.origin`. A literal `:80` comparison misses the request and silently lets a mock login hit the real local API.

**How to apply:** Prefer the isolated test server for auth flows. For preview-browser checks, normalize both origins and fail closed on unexpected auth calls rather than continuing requests to the backend.