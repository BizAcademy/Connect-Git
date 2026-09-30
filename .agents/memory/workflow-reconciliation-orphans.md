---
name: Vite port drift after merges
description: Stale dev-server processes can occupy artifact ports after workflow reconciliation.
---

After a merge, do not assume a running Vite workflow is serving the preview.
Compare its reported open port with the artifact's configured port.

**Why:** Workflow reconciliation has left older Vite listeners alive while
starting new managed workflows. Vite silently selected fallback ports, so the
proxy could continue serving the older process even though the new workflow
reported a successful start.

**How to apply:** If ports differ, identify listener ownership first. Stop only
verified stale processes, then restart the affected managed artifact workflows
once and confirm they bind their configured ports. Do not create replacement
workflows or change artifact ports to follow the fallback.