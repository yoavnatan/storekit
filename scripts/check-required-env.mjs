// Boot-time gate on the secrets a production server cannot run without.
//
// Run as `prestart`, so `npm start` refuses to come up at all when one is missing. Until now the
// guards in seller-auth.ts / admin-auth.ts threw on the FIRST REQUEST that touched a session
// instead — and a per-request throw renders to the visitor as a redirect, with the real reason
// only in the logs. GO_LIVE_CHECKLIST §7 has always described this as "the server fails at boot";
// this is the part that makes that true. (It became possible only once configuration was read
// from process.env at runtime — while it was inlined at build time there was nothing to check.)
//
// Deliberately not a list of every variable: an absent RESEND_API_KEY or GOOGLE_CLIENT_ID is a
// supported configuration (console emails, no Google button). Only the two whose absence means
// "anyone can forge a session" or "/admin is guarded by a password from the public source" belong
// here.
const REQUIRED = [
  { name: 'AUTH_SECRET', devDefault: 'dev-insecure-secret', what: 'signs seller session cookies' },
  { name: 'ADMIN_SECRET', devDefault: 'admin', what: 'is the /admin password' },
];

const problems = [];
for (const { name, devDefault, what } of REQUIRED) {
  const value = process.env[name];
  if (!value) problems.push(`${name} is not set — it ${what}.`);
  else if (value === devDefault) problems.push(`${name} is still the public dev default — it ${what}.`);
}

if (problems.length) {
  console.error(
    `\nRefusing to start.\n\n${problems.map((p) => `  · ${p}`).join('\n')}\n\n` +
      'Set them in the server environment (or a .env file next to package.json — a real\n' +
      'environment variable wins over it). Generate each with: openssl rand -hex 32\n' +
      'See GO_LIVE_CHECKLIST.md §7. For local development use `npm run dev`, which\n' +
      'keeps the dev defaults on purpose.\n',
  );
  process.exit(1);
}
