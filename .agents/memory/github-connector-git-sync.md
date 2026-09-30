---
name: GitHub connector and Git synchronization
description: How to preserve Git history when the remote's CLI authentication fails but the connected GitHub integration can write.
---

A connected GitHub integration can have repository write permission even when the workspace's Git remote uses an invalid credential. Do not assume that OAuth access to the connector also authenticates `git push`.

**Why:** Replacing a failed push with a force push risks overwriting others' work, while publishing a different commit through the API would leave the local and remote histories diverged.

**How to apply:** If normal Git authentication fails, confirm the connector's write permission and the remote head. Through the Git Data API, create missing blobs, trees, and commits only when their returned SHAs match the local objects. Advance the ref with `force: false` only after all commits exist and the old head still matches. Fetch and compare the local and remote head/tree afterward. Never inspect or print connector credentials.