---
name: Filtered workspace install
description: Restoring dependencies for one artifact when unrelated workspace packages block a root install
---

When a workspace-wide pnpm install fails because a package in another workspace cannot be downloaded, try a filtered install for the artifact that actually needs dependencies. A filtered install can succeed using already cached packages without changing unrelated dependencies.

**Why:** The root install was blocked by a package-firewall response for an unrelated code-generation dependency, while the component-preview artifact's missing Vite link was restored by a filtered offline install.

**How to apply:** Confirm that the missing executable belongs to the selected workspace package, then use `pnpm --filter <workspace-package> install --offline --frozen-lockfile` before considering dependency changes. Do not bypass a package-firewall block or assume the root install must succeed to run one artifact.