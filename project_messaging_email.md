---
name: project-messaging-email
description: Messaging system uses option B (no SMTP now) — email stub must be wired later
metadata: 
  node_type: memory
  type: project
  originSessionId: f66c5fa7-8f27-4608-82c2-a816ad46747e
---

The messaging system (buyer → seller contact form) was built with a stub for outgoing email.

**Why:** No SMTP configured yet; seller sees buyer's email directly in dashboard and contacts them manually for now.

**How to apply:** When adding SendGrid/Brevo (see [[project_israel_market]] — email via SendGrid/Brevo), wire the stub in `src/lib/mailer.ts` → call it from `/api/contact` (initial message confirmation to buyer) and from `/api/messages` reply action (reply notification to buyer).
