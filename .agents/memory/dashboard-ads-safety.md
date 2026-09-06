---
name: Dashboard ads safety
description: Security and content-format rule for administrator-authored dashboard advertisements.
---

Dashboard advertisement copy must remain an array of plain-text segments with a validated hexadecimal color. Never replace it with HTML entered by administrators.

**Why:** Advertisements are stored and displayed to every authenticated user. Allowing rich HTML would create a persistent XSS path; structured text supports partial coloring without executing markup.

**How to apply:** Extend the structured schema with explicit validated fields when adding formatting. Render every text value through normal React text interpolation, not `dangerouslySetInnerHTML`.