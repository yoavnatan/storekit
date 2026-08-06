---
name: project-tab-strip-alert-beacon
description: A dashboard tab marker that scrolls off the strip is flagged by a coloured dot on the edge fade; every marker declares its own severity
metadata: 
  node_type: memory
  type: project
  originSessionId: f1920bee-d965-48b7-9492-f748aa8f6ed1
  modified: 2026-08-05T19:35:15.694Z
---

Both dashboards' `.dash-tabs` strips scroll sideways on a phone, and a marker on
an off-screen tab (low stock, new orders, unread messages, admin "(N) new") used
to be invisible. Built 2026-08-05: `src/scripts/dashboard/tab-alert-edges.ts`
puts a dot in the marker's colour on the edge fade you'd scroll toward.

**The rule a NEW tab marker has to follow:** declare `data-tab-alert` on the
marker element itself — `"danger"` (red, `--color-danger`) = someone is waiting
or something is unseen, which is what the site already paints red everywhere;
`"warning"` (orange, `--color-warning`) = a wrong state that can wait, today only
low stock. Nothing else knows which tab means what, deliberately: there are five
marker sites across three modules and a lookup table would be a sixth copy.
Highest severity present that way wins the colour.

**Why:** the fade said "there is more this way" and could not say "and something
over there needs you" — so there was no reason to scroll and find out.

**How to apply:** add the attribute wherever a tab marker is created, SSR *and*
the JS that rebuilds it. A MutationObserver on the strip drives the beacon, so no
writer has to call anything back — see [[feedback-new-state-sweep-consumers]].
The RTL mapping is the part that breaks silently: the "start" fade is on the
RIGHT in Hebrew, so a marker off the visual left is at the logical *end*
([[project-rtl-arrow-keys]], same trap). Guarded by `tests/tab-alert-edges.test.ts`.
