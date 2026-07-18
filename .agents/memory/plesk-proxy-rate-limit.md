---
name: Plesk double proxy & API rate limit
description: Why the admin users list showed empty in prod, and the trust-proxy/rate-limit rules that prevent it.
---

**Rule 1:** On Plesk (nginx → Apache/Passenger → Node = 2 private hops), Express must use `app.set("trust proxy", ["loopback", "linklocal", "uniquelocal"])`. `trust proxy = 1` only unwinds one hop, so `req.ip` becomes the internal proxy IP and ALL site visitors share ONE express-rate-limit bucket.

**Why:** With a shared 100 req/min bucket, one-shot requests (admin users list, fired once on tab mount) got 429 "Trop de requêtes" and stayed empty, while endpoints polled every 15 s (total-balance card) eventually succeeded — misleading symptom: "counter works but list is empty". The failure toast auto-dismisses, so users report no error. Server, DB and RLS were all fine.

**Rule 2:** Middleware mounted at `app.use("/api", limiter, ...)` sees `req.path` WITHOUT the `/api` prefix. Any exemption (`skip`) must test `req.originalUrl`, not `req.path` — the AfribaPay webhook exemption silently never matched for this reason.

**How to apply:** When prod symptoms are "endpoint works via curl but fails in the browser", check `RateLimit-*` response headers first. To test authenticated prod endpoints without a password: service-role `POST /auth/v1/admin/generate_link` (type magiclink) → `POST /auth/v1/verify` (token_hash) → Bearer token; log out the session afterwards.

Current cap: 600 req/min per client IP (CGNAT in Francophone Africa makes per-IP buckets coarse — many users share one mobile-carrier IP).
