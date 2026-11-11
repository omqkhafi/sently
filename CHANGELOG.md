# Changelog

## [Unreleased]

## [1.3.0] — 2026-11-11

### ✨ Added

- **SMTP deadlines and STARTTLS policy** — `greetingTimeout`, `socketTimeout`,
  and optional `sendTimeout` now bound connect, greeting, and each reply.
  `starttls` is `opportunistic` (default), `required`, or `never`. `clientName`
  is the EHLO identity. `attachmentBasePath` rejects attachment paths and
  symlinks outside a directory. HTTP transports default to a 30s deadline
  (`timeoutMs` on Resend).
- **`TLS_FAILED` and `TRANSIENT`** — certificate and required-STARTTLS failures
  use `TLS_FAILED`. SMTP 421/450/451 use `TRANSIENT` with `permanent: false`.

### ♻️ Changed

- **EHLO and Message-ID** — EHLO sends `clientName` (OS hostname by default),
  not the relay host. The default Message-ID is `<uuid@from-domain>`.
- **8-bit bodies** — lines longer than 998 bytes, or bodies when the server
  did not advertise `8BITMIME`, are quoted-printable. `BODY=8BITMIME` is sent
  only when the message stays 8-bit.
- **Webhook freshness** — Resend and Mailgun signatures reject timestamps
  older than 300 seconds. Pass `0` to disable the check.
- **Retry** — `maxAttempts` must be an integer ≥ 1. Backoff is capped by
  `maxDelay` (default 60s). `BAD_REQUEST`, `INVALID_CONFIG`, and
  `SMTP_AUTH_FAILED` are not retried.
- **Workers hooks** — `node:async_hooks` loads on the first send, not at
  import. Cloudflare sender entrypoints need the `nodejs_compat` flag.
  `sently/adapters/cf` does not. STARTTLS there passes
  `expectedServerHostname` when the host is not an IP.
- **Bundle budgets** — gzip budgets match the 1.3.0 SMTP, HTTP, and adapter sizes.
- **Still opt-in** — `timeoutMs` is a Resend option; other HTTP transports
  use the 30s default. `attachment.path` stays trusted local I/O unless
  `attachmentBasePath` is set. Default `starttls` stays `opportunistic`.
  SendGrid, Postmark, Brevo, SES, and Unifonic webhooks stay parse-only.

### 🐛 Fixed

- **AUTH mechanism selection** — `250 AUTH LOGIN PLAIN` selects LOGIN instead
  of failing to find a method. `AUTH=LOGIN` is recognized.
- **SMTP reads** — a reply that arrives immediately after the previous one is
  kept. Bytes after a STARTTLS 220 are discarded before the handshake.
- **RCPT and DATA** — a message whose recipients are all rejected does not
  enter DATA. A failed body write is not sent twice. Non-pool sends on one
  transport no longer interleave.
- **Shared send hooks** — concurrent sends keep their own retry and fallback
  callbacks. `sendBulk` records a success before `onSuccess`. `concurrency`
  must be a finite integer ≥ 1. Idempotency dedupes in-flight sends and
  batches. A non-fallback error does not put a provider in cooldown.
- **HTTP error bodies** — a non-JSON error response throws `SentlyError` with
  the status code. An empty success body is a provider error. DKIM relaxed
  canonicalization keeps empty lines in the middle of the body. Attachment
  filenames that are not quoted-string-safe use RFC 2231.
- **Fresh `bun test`** — the API surface tests load source when `dist/` has
  not been built yet.
- **HTTP `null` bodies** — a non-OK JSON `null` body throws `SentlyError`
  with the status code. Resend `verify()` no longer treats an HTML 200 as a
  valid API key.

### 🔒 Security

- **Cleartext mail** — `starttls: "required"` refuses to send when STARTTLS
  is missing or the handshake fails. `requireTLS` still refuses AUTH on a
  connection that never upgraded. Implicit TLS does not send an IP address
  as the TLS server name.
- **Header injection** — `messageId`, attachment `contentType`, and
  `contentId` that contain CR, LF, or NUL are rejected.
- **Error text** — `JSON.stringify` on `SentlyError` and `SMTPError` omits
  the server reply. Safe fields are `sentlyCode`, `command`, `statusCode`,
  and `permanent`.
- **STARTTLS handshake** — a `220` that never finishes TLS makes `send()`
  reject with `TIMEOUT`, including when the adapter timer wins and close
  runs on the plaintext socket. The same stall rejects a pooled `send()`.
  The deadline is `socketTimeout` (or `connectionTimeout` on the Node and
  Bun adapters). `sendTimeout` bounds a direct or pooled send even when
  those other deadlines are off.

## [1.2.2] — 2026-08-19

### ♻️ Changed

- **Repository owner** — GitHub, docs, and npm Trusted Publisher coordinates
  moved from `alialnaghmoush/sently` to `omqkhafi/sently`
- **JSR scope** — the published package is now `@omqkhafi/sently`;
  `@alialnaghmoush/sently` stays on the registry but will not receive new
  versions. README and install docs tell consumers to switch with
  `bunx jsr add @omqkhafi/sently`

## [1.2.1] — 2026-08-04

### ✨ Added

- **Taqnyat Verify OTP live verified** — production `sendOtp` → handset code →
  `verifyOtp` confirmed; docs OTP tab shows the green `LiveVerified` callout
  alongside SMS, WhatsApp, and Email

### ♻️ Changed

- **Hostinger SMTP unified** — SMTP settings now come from the same name via
  function overloading: `HostingerTransport({ user, pass })` returns a ready
  `SMTPConfig` for `createSMTPMailer`, while `new HostingerTransport({ token,
  mailbox })` stays the Mail API transport; IntelliSense narrows options and
  the return type by config shape; `hostingerSmtpConfig()` remains as a 1.x
  compatibility alias

### 🐛 Fixed

- **Taqnyat Verify OTP parsing** — live `returnJson: 1` responses put the docs
  result code in `Data.result` and use top-level `status: 1` as a transport
  envelope; `sendOtp` / `verifyOtp` now read `Data.result` (and
  `Data.MessageEn` / `Data.MessageAr`) so a successful send is no longer
  misreported as code `1` (invalid apiKey)

## [1.2.0] — 2026-08-03

### ✨ Added

- **Hostinger transport** — `sently/transports/hostinger` sends from a managed
  Hostinger mailbox through the Hostinger Mail API (Bearer token +
  mailbox resource ID); `listMailboxes()` discovers mailbox IDs and `verify()`
  checks token scope; vendor extras `sendReply` / `sendForward` thread by
  folder + IMAP UID; `hostingerSmtpConfig()` fills ready SMTP settings for
  `createSMTPMailer` (`smtp.hostinger.com`, ports 465/587)
- **Hostinger brand mark** — React `HostingerLogo` (full wordmark from
  hostinger.com) / `HostingerLogoIcon` (purple H); docs title badge uses the
  wordmark, sidebar/marquee use the H mark
- **Hostinger docs** — Mail API + SMTP feature tabs (send, HTML, attachments,
  CC/BCC, reply/forward, mailboxes, verify, SSL/STARTTLS/pool) at the same
  depth as Taqnyat; links to Hostinger developers / Mail API / SMTP tutorial;
  green `LiveVerified` on SMTP (production relay previously proven); homepage
  marquee marks Hostinger verified
- **Taqnyat Email live verified** — opt-in live suite delivered a real message
  via `mailSend.php` with an approved portal sender; docs show the green
  `LiveVerified` callout for Email alongside SMS and WhatsApp

## [1.1.1] — 2026-08-02

### 🐛 Fixed

- **Publish CI Test job** — build `dist` before `bun test` so parallel Verify no
  longer fails api-surface suites that import published bundles
- **`bun test` skips live suites** — clears `TAQNYAT_LIVE` / `SNDR_LIVE` /
  `INBUCKET_LIVE` and ignores `**/*.live.test.ts`; `bun run test:live` is
  local-only (refuses `CI` / `GITHUB_ACTIONS`)

## [1.1.0] — 2026-08-02

### ✨ Added

- **Web Push live verified** — homepage transport strip marks Web Push verified
  after okengine delivered a real browser notification with VAPID; docs page
  shows the green `LiveVerified` callout
- **Web Push brand mark** — React `WebPushLogo` / `WebPushLogoIcon` (blue
  notification tile + bell + badge); docs title badge + sidebar/marquee use
  the mark
- **Web Push protocol knobs** — `urgency` / `topic` headers (RFC 8030), rich
  Notification fields (`badge`, `image`, `tag`, `actions`, `requireInteraction`,
  `renotify`), `silent` / data-only payloads, and `generateVapidKeys()` on
  `sently/transports/webpush`
- **Inbucket transport** — `sently/transports/inbucket` for local SMTP capture
  (defaults `localhost:2500` / UI `http://localhost:9000`) with REST helpers
  `listMailbox`, `getMessage`, `getSource`, `markSeen`, `deleteMessage`,
  `purgeMailbox`, and `mailboxForAddress`; opt-in live suite via
  `INBUCKET_LIVE=1`; docs under a new **Email Dev** sidebar group with Mailpit
- **Mailpit vendor extras** — `search`, `getHeaders`, `htmlCheck`, `linkCheck`,
  and `setRead` on `MailpitTransport` for local inbox assertions; docs cover
  the helpers and link to the Mailpit API
- **Mailpit brand mark** — React `MailpitLogo` / `MailpitLogoIcon` from the
  official SVG; docs title badge + sidebar/marquee use the mark; Mailpit is
  live-verified in the transport strip
- **Taqnyat live suite** — opt-in `tests/integration/taqnyat.live.test.ts`
  (`TAQNYAT_LIVE=1`) with free preflight before SMS / Mail / WhatsApp sends;
  live env keys documented in `.env.example`
- **Taqnyat transport docs** — single `/docs/transports/taqnyat` page under a
  new **Multi-channel** sidebar group (SMS / WhatsApp / Email sections);
  green `LiveVerified` on SMS and WhatsApp only
- **Taqnyat SMS vendor extras** — `getBalance`, `listSenders`, `schedule`,
  `deleteScheduled` on `TaqnyatSmsTransport` (OTP helpers unchanged)
- **Taqnyat WhatsApp vendor extras** — `listTemplates`, `createTemplate`,
  `deleteTemplate`, `optIn` / `optOut`, `sendWithFailover` on
  `TaqnyatWhatsAppTransport`
- **Taqnyat brand marks** — React `TaqnyatLogo` / `TaqnyatLogoIcon` replace the
  `TQ` monogram; marquee uses the full wordmark alone, sidebar uses a square
  single-dot icon (docs page keeps the brand wordmark)
- **Transport strip tiers** — homepage marquee legend:
  color = live verified, muted = available, sponsors reserved;
  verified chips use the same icon+label rhythm as the rest (brand-colored
  mark); full wordmarks stay on docs pages; priority marks sit after a ~25%
  available lead-in
- **SNDR brand mark** — React `SndrLogo` / `SndrLogoIcon` from
  [sndr.sh](https://www.sndr.sh/sndr-logo.svg); docs page rewritten with
  LiveVerified, contact resources, and platform coverage table
- **SNDR webhooks** — map `email.queued`, `failed`, `complained`, `opened`,
  and `clicked` into normalized `EmailEvent` types

### ♻️ Changed

- **Homepage messaging** — clearer TypeScript notification/messaging
  positioning (Email · SMS · WhatsApp · Push), one-package signal, provider
  swap strip (`SMTP → SES → Resend`), tighter why cards; no section removals
- **`/llms.txt`** — agent preamble states notification/messaging library
  (not a queue); Fumadocs handbook index unchanged underneath
- **Publish CI** — `.github/workflows/publish.yml` runs only on `v*` tag
  pushes; Verify (typecheck, lint, build, test) and npm / JSR publish jobs
  run in parallel (no longer sequential npm-then-JSR on push to `main`)
- **README** — shieldcn grid/left header with cleaned logo SVGs (no
  clip-path square), drop Bundlephobia badge, add npm downloads chart;
  version badges match the okengine pattern (`/npm/…`, `/jsr/…`)

### 🔥 Removed

- **`test.yml` workflow** — PR / push CI matrix removed; release Verify lives
  in `publish.yml` on version tags

### 🐛 Fixed

- **Taqnyat WhatsApp queued accept** — treat `statuses: "PENDING"` (and
  template/text accepts without `message_id` yet) as success instead of an
  empty id edge case
- **`bun run verify` never hits provider live suites** — clears `TAQNYAT_LIVE` /
  `SNDR_LIVE` / `INBUCKET_LIVE` and ignores `**/*.live.test.ts` so a leftover
  shell export cannot send real SMS / email / WhatsApp during verify; use
  `bun run test:live` to opt in

## [1.0.1] — 2026-08-01

### 🐛 Fixed

- **Web Push `subject` validation** — `WebPushTransport` rejects invalid
  VAPID `subject` values at construction (`mailto:` / `https:` only) instead
  of failing later with an opaque push-service 403

## [1.0.0] — 2026-08-01

First stable release. Channel contracts and Supported transports are semver-frozen;
npm publishes ship with provenance attestations and Trusted Publishing (OIDC).
sently is the channel-delivery layer — preference centers, digests, workflows, and
in-app inboxes sit on top (custom or Novu / Knock / Courier), not instead of it.

### ✨ Added

- **Stability policy** — what is frozen at 1.x vs allowed without a major
  (`PushOptions` union, `providerIndex`, email-only preview / idempotency)
- **Support matrix** — Supported vs Available transports and runtimes
- **Non-goals** — library-not-platform boundaries (no preference centers /
  digests / workflow builders inside sently)
- **Security policy** — root `SECURITY.md` (private reporting, response targets,
  supported versions for patches, Trusted Publisher setup notes)
- **Compare guide** — positioning vs vendor SDK piles, Nodemailer, and
  Novu / Knock / Courier
- **Failover guide** — cross-channel retry-then-fallback recipes
- **Mailpit transport** — `sently/transports/mailpit` for local email capture
  (SMTP defaults `localhost:1025`, REST helpers for list / get / delete)

### ♻️ Changed

- **Messaging positioning** — homepage, README, `llms.txt`, and package
  description/keywords lead with multi-channel scope creep (one sender / error /
  retry model); bundle size as supporting evidence for edge / Workers; FCM
  documented as current HTTP API support, not a feature boast
- **Handbook landing** — install → send loop, channel map, where-next table,
  and library-vs-platform troubleshooting
- **Docs IA** — remove duplicate Quick start section; Channels is the first-send
  path; cross-links for stability, support matrix, failover, and security
- **Migrate from Nodemailer** — diff-style transporter and `sendMail` → `send`
  swaps, field map, SMTP → HTTP follow-on, fuller options tables
- **npm publish** — OIDC Trusted Publishing first, optional `NPM_TOKEN`
  fallback; continues to use `npm publish --provenance` from CI (npm CLI ≥11.5.1
  check in the publish workflow)
- **Semver** — public channel factories, contracts, hooks, `SentlyError` codes,
  `ChannelSendResult`, and published subpaths follow 1.x stability

## [0.10.0] — 2026-08-01

### ✨ Added

- **Channel send result** — `toChannelSendResult` / `ChannelSendResult`
  (`sently/channel-result`, also on the main barrel) maps email, SMS,
  WhatsApp, and push results to `{ messageId, provider, accepted }`
- **Cross-channel decorators** — `RetryTransport`, `FallbackTransport`, and
  `WeightedFallbackTransport` wrap SMS / WhatsApp / Push transports; SMS /
  WhatsApp / push senders wire `onRetry` / `onFallback` like email
- **Unifonic SMS** — `sently/transports/unifonic` (`AppSid` + el.cloud REST
  send); webhook parser at `sently/webhooks/unifonic`
- **FCM push** — `sently/transports/fcm` (current FCM HTTP API + service-account
  JWT, no Google SDK)
- **Non-email webhooks** — `DeliveryEvent` plus parsers for Twilio SMS and
  WhatsApp Cloud (`sently/webhooks/twilio-sms`, `whatsapp-cloud`);
  `toDeliveryEvent` maps `EmailEvent` into the shared shape; Twilio and
  WhatsApp Cloud parsers expose `verifySignature` for inbound authenticity
- **Docs landing** — homepage transport marquee and channel cards include
  Unifonic and FCM

### ♻️ Changed

- **`PushOptions`** — union of `WebPushOptions` (`subscription`) and
  `FcmPushOptions` (`token`); Web Push and FCM transports reject the wrong
  shape
- **SMS / WhatsApp / Push results** — optional `providerIndex` when a
  fallback decorator handles the send

### 🐛 Fixed

- **Unifonic success parsing** — accept OpenAPI `success: "true"` (string) in
  addition to boolean `true`
- **Unifonic `statusCallback`** — reject non-HTTPS URLs at construction (el.cloud
  OpenAPI requires a public HTTPS callback)
- **Empty FCM token** — reject blank `token` before calling the FCM API
- **Landing provider strip** — keep transport icons and labels on one vertical
  midline in the homepage marquee

### 🔒 Security

- **WhatsApp Cloud webhooks** — `verifySignature` for `X-Hub-Signature-256`
  (HMAC-SHA256 over the raw body with the Meta app secret)
- **Twilio SMS webhooks** — `verifySignature` for `X-Twilio-Signature`
  (HMAC-SHA1 over URL + sorted form params with the Auth Token)

## [0.9.2] — 2026-08-01

### ♻️ Changed

- **`bun run verify`** — runs `site:build` before tests so static-export and
  docs-site failures block pack/publish
- **CI Actions** — `actions/checkout` and `actions/setup-node` to v7; Node smoke
  job on Node 24 (drops the Node 24 force-env workaround)

### 🐛 Fixed

- **Apple touch icon** — mark `apple-icon` as force-static so `output: "export"`
  can prerender it during `site:build`

## [0.9.1] — 2026-08-01

### 🐛 Fixed

- **SNDR live suite opt-in** — require `SNDR_LIVE=1` (plus credentials) so
  `bun run verify` stays offline-safe when `.env` has keys
- **Docs header geometry gate** — assert the home brand cell against
  `HeroIntro`'s left-pane width after the hero split moved out of `page.tsx`

## [0.9.0] — 2026-08-01

### ✨ Added

- **Channel senders** — `createSmsSender` (`sently/sms`), `createWhatsAppSender`
  (`sently/whatsapp`), `createPushSender` (`sently/push`) alongside email; each
  sender supports plugins and lifecycle hooks
- **SMS transports** — Twilio, Taqnyat SMS, Msegat (`sently/transports/twilio-sms`,
  `taqnyat-sms`, `msegat`); vendor OTP helpers stay on the transport class
- **WhatsApp transports** — WhatsApp Cloud API, Taqnyat WhatsApp
  (`sently/transports/whatsapp-cloud`, `taqnyat-whatsapp`)
- **Web Push transport** — VAPID Web Push (`sently/transports/webpush`)
- **Email transports** — Sndr, Taqnyat Mail (`sently/transports/sndr`,
  `taqnyat-mail`)
- **Sndr webhooks** — `parseSndrWebhook` / `verifySndrSignature`
  (`sently/webhooks/sndr`, also via `sently/webhooks`)
- **Per-provider webhook subpaths** — `sently/webhooks/{brevo,mailgun,postmark,
  resend,sendgrid,ses,sndr}` for tree-shakeable imports
- **Docs site** — Next.js + Fumadocs handbook under `site/` (`bun run site:dev`)
- **Web Push interop example** — `examples/webpush-interop`
- **`AGENTS.md`** — agent contract for the sently-first provider model (replaces
  `CLAUDE.md`; published with the package)

### ♻️ Changed

- **Library scope** — channel-first messaging (email, SMS, WhatsApp, push), not
  email-only; package description and README updated accordingly
- **Docs site branding** — real sently wordmark / mark in the header, homepage,
  404, favicon, Apple touch icon, and docs OG images; README shows the logo

## [0.8.0] — 2026-06-07

### ✨ Added

- **`FallbackTransport`** (`sently/transports/fallback`) — provider failover through an ordered transport list; composes with `RetryTransport`; `FallbackError.attempts` records `{ provider, error }` per failed attempt
- **Five HTTP providers:** MailerSend, Plunk, SparkPost, Mailtrap, Loops (`sently/transports/mailersend`, `plunk`, `sparkpost`, `mailtrap`, `loops`)
- **`SendResult.provider`** and **`SendResult.providerIndex`** — set by `FallbackTransport` to identify which provider handled the send
- **`durationMs`** optional third argument on `onSuccess` / `onError` mailer hooks (backward compatible)
- **`consoleObserver`** (`sently/observability`) — ready-made console logging hooks; also exported from main `"sently"` barrel
- **Mailer `onFallback` hook** — `onFallback(ctx, failedProvider, nextProvider, error)` on `MailerHooks`; wired automatically when using `FallbackTransport` or `WeightedFallbackTransport`
- **Provider cooldowns** — `FallbackTransport(transports, { cooldownMs })` skips unhealthy providers until cooldown expires; shared across `WeightedFallbackTransport` sends
- **`verifyAll()`** on `FallbackTransport` / `WeightedFallbackTransport` — per-provider `{ ok, providers: [{ provider, ok, message? }] }` result; `verify()` still returns the first healthy provider
- **`WeightedFallbackTransport`** (`sently/transports/weighted-fallback`) — weighted-random primary provider with failover through remaining providers
- **`Transport.provider`** — stable provider identifier on every transport class; `getProviderLabel()` prefers it over `constructor.name` inference
- **`CloudflareEmailTransport`** (`sently/transports/cloudflare-email`) — Workers `send_email` binding transport (not fetch HTTP)

## [0.7.2] — 2026-05-31

### 🐛 Fixed

- Publish workflow runs `bun run build` before registry steps and publishes **npm before JSR** so a failed npm step does not leave JSR ahead of npm
- `scripts/publish.ts` `syncVersion()` skips rewriting `jsr.json` when content is unchanged (avoids dirty working tree between CI publish steps)

## [0.7.1] — 2026-05-31

### 📚 Documentation

- README Nodemailer comparison updated for **v8.0.10** (~58 KB gzip, zero deps, 2026 releases)
- Bundle size figures refreshed from `bun run measure:size:md` (~6.1 KB HTTP, ~15 KB SMTP, ~2.6 KB `sently/mailer`)
- `llms.txt` and `CLAUDE.md` aligned with measured gzip sizes

## [0.7.0] — 2026-05-31

### 💥 Breaking + Migration

Summary:

- **Transport-only `createMailer`** — passing SMTP config (`host` / `port` / `auth`) to
  `createMailer` from `sently` or `sently/mailer` throws `SentlyError` (`INVALID_CONFIG`)
  at factory time with guidance to use `createSMTPMailer`.
- **`sently/smtp`** — removed `createMailer` alias; export is **`createSMTPMailer` only**
  (also available from main `"sently"`).
- **`CreateMailerOptions`** removed — use **`TransportMailerOptions`** or
  **`SMTPMailerOptions`** instead.
- **Main barrel slimmed** — `"sently"` no longer re-exports transports, webhook parsers,
  idempotency, DKIM helpers, template plugin, or `SMTPPool`. Import from subpaths
  (e.g. `sently/transports/resend`, `sently/webhooks`).
- **Prior breaks documented in one place:** v0.5.1 react barrel move; v0.6.2
  transport-only main `createMailer`; v0.5.x bulk-send behavior (native batch, default
  2 req/s throttle, `SendResult.batchError`).

### ✨ Added

- **`INVALID_CONFIG`** stable error code for misconfigured mailer factories
- **`SMTPMailerOptions`** type for SMTP factory config
- README decision-tree section and Microsoft 365 OAuth2 example

### ♻️ Changed

- **`BulkSendOptions.concurrency` TSDoc** — documents default `1` (matches implementation)
- Bundle size budgets updated for slimmer main entry
- JSDoc and README examples use explicit subpath imports

## [0.6.2] — 2026-05-31

### ✨ Added

- **`sently/smtp`** subpath — SMTP `createMailer` (`host` / `port` / `auth`, pooling,
  adapters) isolated from the main entry for smaller HTTP app bundles

### ♻️ Changed

- **Breaking:** main `createMailer` from `sently` is transport-only (same as
  `sently/mailer`). SMTP relay apps use `import { createMailer } from "sently/smtp"`
  or `import { createSMTPMailer } from "sently"`.
- **`RetryTransport`** — auth-failure detection uses `SentlyError.sentlyCode` instead
  of importing `SMTPError` (leaner `sently/mailer` graph).
- **`mailer.ts`** — retry hook wiring duck-types `setMailerOnRetry` (no static
  `RetryTransport` import).
- **Build** — remove `dist/` before each `bun run build` to avoid stale chunks in
  published tarballs (~137 KB npm tarball vs ~424 KB with stale chunks).
- Bundle size budgets and README tables updated for measured gzip sizes (main entry
  ~2.4 KB; HTTP stack ~6 KB).

## [0.6.1] — 2026-05-31

### 🐛 Fixed

- **Build** — emit `dist/core/errors.js` so the main barrel and Node/Deno smoke
  tests resolve `SentlyError` imports after `bun run build`

### ♻️ Changed

- Bundle size budgets adjusted for minor measurement drift on CI runners

## [0.6.0] — 2026-05-31

### ✨ Added

- **`sently/errors`** — unified `SentlyError` base class with stable machine-readable
  codes (`RATE_LIMITED`, `BAD_REQUEST`, `SMTP_AUTH_FAILED`, etc.); all existing
  transport error classes now extend `SentlyError` while preserving their names,
  constructor signatures, and public properties (**additive, backward-compatible**)
- **Mailer lifecycle hooks** — optional `hooks` on `createMailer` (`onSend`,
  `onSuccess`, `onError`, `onRetry`) for metrics and tracing on every send;
  hook context includes `to`, `subject`, `provider`, and `messageId` only (no
  body/PII); `RetryTransport` wires `onRetry` per attempt (**additive**)
- **`AUDIT-v0.6.md`** — README capability audit with file/line proof (all claims
  verified implemented, including CRAM-MD5)

### ♻️ Changed

- Bundle size budgets updated for expanded mailer (hooks) and error hierarchy

## [0.5.2] — 2026-05-31

### 🐛 Fixed

- **Build** — `dist/webhooks.js` and `dist/react.js` are generated from source instead
  of bundled with code-splitting, fixing `SyntaxError: Export 'k' is not defined` when
  importing `sently` or `sently/webhooks` in Node.js

## [0.5.1] — 2026-05-31

### 💥 Breaking

- **Main barrel** — `reactPlugin` and `ReactMailOptions` are no longer exported from
  `"sently"`. Import them from `"sently/react"` instead.

### 🐛 Fixed

- **Webhook signatures** — `verifyResendSignature` and `verifyMailgunSignature` now
  compare decoded signature bytes with constant-time `timingSafeEqual` (Web Crypto only)
- **SES webhooks** — SNS `Message` field accepted when already parsed as an object
- **Batch sendBulk** — per-chunk failure isolation, per-message partial batch errors
  (`SendResult.batchError`), and rate limiting between batch HTTP requests (default 2/s)

### ♻️ Changed

- `RateLimiter` extracted to `src/core/rate-limiter.ts` (shared by pool and mailer)
- `Transport.batchMax` on `ResendTransport`; `BulkSendOptions.rateDelta` / `rateLimit`
- Bundle size budgets updated for expanded mailer and Resend transport

## [0.5.0] — 2026-05-31

### ✨ Added

- **`sently/react`** — React Email integration via `reactPlugin()`; optional peers
  `react` and `@react-email/render`; `options.react` on `MailOptions`
- **`sently/idempotency`** — `IdempotencyTransport` decorator with
  `MemoryIdempotencyStore`; dedupe on retry/replay; Resend native
  `Idempotency-Key` header support
- **Native batch in `sendBulk`** — optional `Transport.sendBatch()` on Resend
  (POST `/emails/batch`, `RESEND_BATCH_MAX = 100`) and SendGrid (multi-
  personalization); attachment messages fall back to single-send
- **`stopOnError`** option on `BulkSendOptions`
- **`sently/webhooks`** — normalized `EmailEvent` parsers for Resend, SendGrid,
  Postmark, Mailgun, SES (SNS envelope + double-encoded Message), and Brevo;
  optional Mailgun HMAC and Resend Svix signature verification helpers
- **`deduped`** flag on `SendResult` for idempotency cache hits

### ♻️ Changed

- `sendBulk` uses native batch endpoints when the transport implements
  `sendBatch`; concurrent per-message fallback unchanged for other transports
- SendGrid single-send puts `subject` in personalization (batch-compatible)
- Bundle size budgets adjusted for expanded `sently/mailer` and main entry

## [0.4.7] — 2026-05-30

### ✨ Added

- **`sently/mailer` entry** — transport-only `createMailer` without SMTP code in the
  bundle (~4.3 KB with HTTP transports vs ~14 KB from the main entry)
- **`sently/dkim` entry** — optional DKIM signing; MIME lazy-loads it only when
  `dkim` config is passed (~1.7 KB)
- **`TransportMailerOptions`** type for the `sently/mailer` entry
- **Bundle size CI gate** — `bun run check:size` enforces gzip budgets in
  `tools/bundle-size-budgets.json`
- **`bun run measure:size`** / **`measure:size:md`** — categorized bundle reports
  for docs and CI
- **Deno and Cloudflare adapter smoke tests** in CI

### ♻️ Changed

- Lazy-load SMTP transport and pool from `createMailer` when using SMTP config
- Extract `MailerImpl` to `src/mailer.ts`; full `createMailer` in `detect.ts` delegates
  to it for custom transports
- **`dist/index.js` generated from `src/index.ts`** via `scripts/generate-index-js.ts`
  (no hand-maintained export list)
- **Minified `dist/` output** in production builds
- **Pinned devDependency versions** (Biome 2.4.16, TypeScript 6.0.3, `@types/node`
  25.9.1, MCP SDK 1.29.0)

### 📚 Documentation

- README **Bundle Size** section — import-path guide, common stacks, per-subpath
  tables, and HTTP stack breakdown
- Inline JSDoc on `src/index.ts` barrel re-exports for JSR symbol documentation
- Corrected bundle size figures (minified + gzip, one decimal KB)

## [0.4.6] — 2026-05-30

### 📚 Documentation

- Documented all remaining exported symbols (class members, interface
  properties, and internal helpers) for 100% JSR symbol documentation
  coverage across adapters, transports, pool, OAuth2, MIME, SigV4, and
  SMTP protocol types

## [0.4.5] — 2026-05-30

### 📚 Documentation

- Added `@module` documentation to the `./pool` entrypoint
- Documented exported interface properties and public API methods across
  core types, adapters, and transports to meet JSR symbol documentation
  requirements (80%+ threshold)

## [0.4.4] — 2026-05-30

### 🔒 Security

- Fixed SigV4 date format: slice(0,15) not slice(0,16) — all real
  SES requests were producing malformed x-amz-date headers
- Added requireTLS guard before SMTP AUTH (default: true when auth
  is set) — prevents credential exposure on STARTTLS-stripping attacks
- Hardened email address validation against header and SMTP command
  injection, enforced centrally in `parseAddresses()` (and re-asserted
  at render time in `toMIMEHeader()`):
  - Rejects CR, LF, NUL, all other C0 control characters (0x00–0x1F),
    DEL (0x7F), and the Unicode line/paragraph separators U+2028/U+2029
  - Fails closed: hostile input throws a clear error with the offending
    code point instead of being accepted
  - No repair or normalization of malicious input — addresses are never
    transformed (e.g. CR/LF stripped) and then accepted
  - Protects the display name as well as the address; an ASCII display
    name such as `"Foo\r\nBcc: ..."` can no longer inject a header
  - Enforced consistently across every address field (From, To, Cc, Bcc,
    Reply-To) and every transport (SMTP, SES, Mailgun, Postmark, Resend,
    SendGrid, Brevo), since all of them route through `parseAddresses()`
- Sanitized attachment filenames and custom attachment headers
  against MIME header injection
- Fixed basePath startsWith sibling-directory bypass in
  resolve-attachments (now appends path separator before comparison)
- Added CRLF guard on EHLO domain for consistency

## [0.4.3] — 2026-05-30

### ✨ Added

- `llms.txt` for LLM/agent discovery (install, quick example, subpath
  exports, and when-to-use guidance)
- README: Nodemailer comparison table, 30-second tour, error handling,
  and TypeScript sections
- `CLAUDE.md` repository map for agents (core entry, adapters,
  transports, tests, build)

### ♻️ Changed

- README positioning, HTTP transport reference table, plugin docs
  reorder, and tree-shaking callout
- `package.json` description and npm keywords for discoverability

## [0.4.2] — 2026-05-30

### 🐛 Fixed

- CI: replaced node -e dynamic import with scripts/smoke.mjs
  (top-level await ESM) for reliable Node.js smoke testing
- CI: integration test now imports from dist/index.js directly
  instead of relying on package self-reference resolution
- CI: updated GitHub Actions to latest patch versions

## [0.4.1] — 2026-05-30

### 🐛 Fixed

- CI: use locally installed tsc (node_modules/.bin/tsc) in build.ts
  instead of bunx tsc to avoid runtime npm downloads in CI
- CI: add bun run build step to SMTP integration job so dist/ exists
  before the integration test imports from 'sently'
- CI: improved smoke test error output with explicit .catch() handler
- CI: added FORCE_JAVASCRIPT_ACTIONS_TO_NODE24 to all workflow jobs

## [0.4.0] — 2026-05-30

### ✨ Added

- `PreviewTransport` — writes emails to disk as .eml or HTML for local development
- `RetryTransport` — decorator transport with exponential/linear/fixed backoff
- `mailer.sendBulk()` — batch send with concurrency control and per-message callbacks
- `templatePlugin` + `simpleEngine` — zero-dependency {{variable}} template rendering
- `verify()` on all HTTP transports (Resend, SendGrid, Postmark, Mailgun, SES, Brevo)
  returns typed `VerifyResult` instead of `boolean`
- `MailOptions.template` and `MailOptions.data` fields for template plugin integration
- `SESTransport` now accepts `dkim` config for signing raw MIME messages
- `attachment.path` basePath guard (opt-in) in resolveAttachments
- GitHub Actions CI matrix: unit tests (Bun), smoke test (Node 22), SMTP integration (Mailpit)

### 🐛 Fixed

- `detectRuntime()` priority hardened: Bun checked before Node.js process globals
- Cloudflare Workers detection uses positive signature (caches + UA), not absence of other runtimes

## [0.3.4] — 2026-05-30

### 🐛 Fixed

- Stale `sendx` references in package.json, build.ts, PROGRESS.md
- JSR badge URL now matches jsr.json scope exactly
- OAuth2 refresh deduplication: `refreshPromise` cleared in `.finally()`
  to correctly handle rejected refresh attempts
- SMTPPool.close() now sets draining flag, rejects new sends,
  and uses Promise.allSettled to drain in-flight messages
- Audited all buildMIME() call sites — await confirmed present

### ✨ Added

- `engines` field in package.json (Node >= 18, Bun >= 1.0)

## [0.3.3] — 2026-05-29

### 🐛 Fixed

- Corrected JSR package name in README from `@sently/sently` to `@alialnaghmoush/sently`

## [0.3.2] — 2026-05-29

### 🐛 Fixed

- Biome formatting in MIME header builder (`src/core/mime.ts`) so `bun lint` passes

## [0.3.1] — 2026-05-29

### 🔒 Security

- Fixed CRLF header injection: `sanitizeHeaderValue()` strips CR/LF
  from Subject, display names, and custom headers in MIME builder
- Fixed SMTP command injection: `MAIL FROM` and `RCPT TO` throw
  `SMTPError` when address contains CR or LF
- Fixed email address validation: `isValidEmail()` rejects strings
  containing CR, LF, or TAB
- Fixed OAuth2 refresh race condition: concurrent `getAccessToken()`
  calls now share a single in-flight refresh Promise
- Added `console.warn` when `rejectUnauthorized: false` is set
  in Node.js and Bun adapters
- Added security note in README for `attachment.path`

## [0.3.0] — 2026-05-29

### ✨ Added

- Plugin system: `plugins` array in `createMailer()` config
  Plugins are `(options: MailOptions) => MailOptions | Promise<MailOptions>` functions
  that run sequentially before message construction
- `MailgunTransport` — Mailgun HTTP API (multipart/form-data)
- `SESTransport` — AWS SES v2 HTTP API with SigV4 signing (Web Crypto)
- `BrevoTransport` — Brevo (formerly Sendinblue) HTTP API
- `TLSOptions.minVersion` — set minimum TLS version for legacy SMTP servers

### 🏁 Parity milestone

sently now covers ~98% of Nodemailer feature parity for modern use cases.
Remaining gaps (SOCKS proxy, iCal) are out of scope by design.

## [0.2.0] — 2026-05-29

### ✨ Added

- DKIM signing (RSA-SHA256 and Ed25519-SHA256) via `SMTPConfig.dkim`
- OAuth2 / XOAUTH2 authentication via `SMTPAuth.type = 'OAUTH2'`
- Connection pooling via `SMTPConfig.pool` and `SMTPPool`
- Rate limiting via `PoolConfig.rateDelta` / `PoolConfig.rateLimit`
- CRAM-MD5 authentication (pure-JS HMAC-MD5)

### ♻️ Changed

- npm package name is `sently`; JSR package name is `@sently/sently`
- `SMTPAuth.pass` is now optional (was required in v0.1)
- `buildMIME()` is now `async` when DKIM config is provided
- `selectAuthMethod` priority: XOAUTH2 > CRAM-MD5 > LOGIN > PLAIN
- `createMailer()` uses `SMTPPool` automatically when `pool: true`

### 🐛 Fixed

- CRAM-MD5 stub now fully implemented

## [0.1.0] — 2026-05-29

### ✨ Added

- Initial release.
