---
name: Filtered workspace install
description: Restoring dependencies for one artifact when unrelated workspace packages block a root install
---

When a workspace-wide pnpm install fails because a package in another workspace cannot be downloaded, try a filtered install for the artifact that actually needs dependencies. A filtered install can succeed using already cached packages without changing unrelated dependencies.

**Why:** The root install was blocked by a package-firewall response for an unrelated code-generation dependency, while the component-preview artifact's missing Vite link was restored by a filtered offline install.

**How to apply:** Confirm that the missing executable belongs to the selected workspace package, then use `pnpm --filter <workspace-package> install --offline --frozen-lockfile` before considering dependency changes. Do not bypass a package-firewall block or assume the root install must succeed to run one artifact.

When an OpenAPI generator is not in the local package cache, the filtered offline install may fail on a missing tarball, and a normal filtered install may be denied by the package firewall. Do not work around the firewall or hand-edit generated output. If runtime work must continue, keep a small explicit API client and mark codegen as still pending.

**Why:** BizPanel's contract change could not regenerate Orval clients because the tarball was absent offline and the package firewall returned 403 for the online fetch.

**How to apply:** After changing an API contract, attempt the documented codegen command. If the declared generator remains blocked, preserve generated files, use a runtime-validated API boundary only as needed, and disclose that regeneration remains pending.