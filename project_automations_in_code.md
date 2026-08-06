---
name: project_automations_in_code
description: "automations built natively in code, never Make/Zapier/no-code platforms"
metadata: 
  node_type: memory
  type: project
  originSessionId: faaa5c8a-e118-44eb-a3ae-f56a7eb44b1c
---

Automations (seller/buyer/admin flows) will be built **directly in code** — never a no-code platform like Make (make.com), Zapier, or any external automation layer. Confirmed 2026-07-19 as a directional decision ("בלי מייק" = "without Make"). Not being built yet — user is only aligning the approach for later ("מכין את השטח").

**Why:** fits [[feedback_architecture]] (modular, no third-party lock-in) and [[feedback_scalability]] (no external tool that breaks at 1000 sellers). Also matches [[project_zero_touch_selfservice]] — every automated flow is owner-code, not an outsourced integration.

**How to apply:** when automations come up, design them as native `/src/lib` + `/src/services` + `/api` code hooked into existing anchor points (`middleware.ts`, `/api/checkout`, `notifications.ts`, the self-healing-errors waypoint). Don't propose Make/Zapier/n8n.
