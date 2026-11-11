<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="https://shieldcn.dev/header/grid.svg?title=sently&subtitle=One+API.+Four+channels.+Every+runtime.&logo=https://raw.githubusercontent.com/omqkhafi/sently/dev/site/public/sentlyIconLogo-w.svg&theme=zinc&size=banner&mode=dark&font=geist&align=left"
    />
    <img
      alt="sently — One API. Four channels. Every runtime."
      src="https://shieldcn.dev/header/grid.svg?title=sently&subtitle=One+API.+Four+channels.+Every+runtime.&logo=https://raw.githubusercontent.com/omqkhafi/sently/dev/site/public/sentlyIconLogo-k.svg&theme=zinc&size=banner&mode=light&font=geist&align=left"
      width="750"
    />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sently"><img alt="npm" src="https://shieldcn.dev/npm/sently.svg?size=sm&variant=outline" /></a>
  <a href="https://jsr.io/@omqkhafi/sently"><img alt="JSR" src="https://shieldcn.dev/jsr/@omqkhafi/sently.svg?size=sm&variant=outline" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="MIT" src="https://shieldcn.dev/npm/license/sently.svg?size=sm&variant=outline" /></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://shieldcn.dev/badge/Bun-ready.svg?logo=bun&size=sm&variant=outline" /></a>
  <a href="https://github.com/omqkhafi/sently/stargazers"><img alt="stars" src="https://shieldcn.dev/github/stars/omqkhafi/sently.svg?size=sm&variant=outline" /></a>
  <a href="https://github.com/omqkhafi/sently/actions"><img alt="CI" src="https://shieldcn.dev/github/ci/omqkhafi/sently.svg?size=sm&variant=outline" /></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sently">
    <picture>
      <source
        media="(prefers-color-scheme: dark)"
        srcset="https://shieldcn.dev/chart/npm/sently.svg?theme=zinc&mode=dark&width=750&height=280"
      />
      <img
        alt="npm downloads"
        src="https://shieldcn.dev/chart/npm/sently.svg?theme=zinc&mode=light&width=750&height=280"
        width="750"
      />
    </picture>
  </a>
</p>

<p align="center">
  <em>Start with email, add SMS and push later — one sender shape, one error model, one retry path. Swap the transport; keep your call sites. Node, Bun, Deno, Workers.</em>
</p>

<p align="center">
  <a href="https://sently.omqkhafi.dev"><strong>Docs</strong></a> ·
  <a href="https://sently.omqkhafi.dev/docs"><strong>Handbook</strong></a> ·
  <a href="https://sently.omqkhafi.dev/llms.txt"><code>llms.txt</code></a> ·
  <a href="https://www.npmjs.com/package/sently"><code>sently</code></a>
</p>

## Install

```bash
bun add sently                                     # npm / Bun / yarn / pnpm
bunx jsr add @omqkhafi/sently                      # JSR
```

JSR consumers on `@alialnaghmoush/sently`: switch to `@omqkhafi/sently`. The old scope will not receive new versions. npm `sently` is unchanged.

Optional peers (React Email only): `react`, `@react-email/render`.

## Quick start

```typescript
import { createMailer } from "sently/mailer";
import { ResendTransport } from "sently/transports/resend";

const mailer = await createMailer({
  transport: new ResendTransport({ apiKey: process.env.RESEND_API_KEY! }),
});

await mailer.send({
  from: "hello@example.com",
  to: "you@example.com",
  subject: "Welcome",
  html: "<p>Sent with sently.</p>",
});
```

Same shape for every channel — apps use **sently senders**, not vendor SDKs:

| Channel  | Sender                               | Example transport                                      |
| -------- | ------------------------------------ | ------------------------------------------------------ |
| Email    | `createMailer` / `createSMTPMailer`  | `sently/transports/resend`, `sently/smtp`              |
| SMS      | `createSmsSender`                    | `sently/transports/twilio-sms`, `unifonic`, `taqnyat-sms` |
| WhatsApp | `createWhatsAppSender`               | `sently/transports/whatsapp-cloud`                     |
| Push     | `createPushSender`                   | `sently/transports/webpush`, `fcm`                     |

Full walkthrough: [Get started](https://sently.omqkhafi.dev/docs/get-started).

## Why sently?

Teams usually start on one channel (often email), then add SMS and push. Each vendor SDK brings its own auth, retries, and error shapes. sently keeps **one sender shape**, **one `SentlyError` model**, and **one retry/fallback path** as you add channels.

**Library, not platform.** sently is the channel-delivery layer. Preference centers, digests, workflow builders, and in-app inboxes — custom logic or tools like [Novu](https://novu.co), [Knock](https://knock.app), or [Courier](https://www.courier.com) — sit **on top of** sently, not instead of it.

Compared with email-only stacks (e.g. Nodemailer) and a pile of vendor clients:

|                   | Typical stack                         | sently                                      |
| ----------------- | ------------------------------------- | ------------------------------------------- |
| As channels grow  | New SDK per channel                   | Same sender factories                       |
| Failures          | Per-vendor exceptions                 | Stable `SentlyError` codes                  |
| Reliability       | Ad-hoc per client                     | `RetryTransport` + `FallbackTransport`      |
| Providers         | Vendor clients in app code            | Pluggable transports                        |
| Runtimes          | Often Node only                       | Node, Bun, Deno, CF Workers (`nodejs_compat` for senders) |
| Edge / Workers    | Fat SDKs hurt cold start              | Tree-shakeable (~6.6 KB HTTP · ~17.6 KB SMTP) |
| Module format     | Often CJS                             | ESM only                                    |
| Dependencies      | Varies                                | 0 runtime deps                              |

More detail: [Compare](https://sently.omqkhafi.dev/docs/guides/compare) · [Stability](https://sently.omqkhafi.dev/docs/get-started/stability) · [Support matrix](https://sently.omqkhafi.dev/docs/get-started/support-matrix).

## Entrypoints

| Import                 | Use when                                      |
| ---------------------- | --------------------------------------------- |
| `sently/mailer`          | HTTP / custom email transports (smallest)   |
| `sently/smtp`            | SMTP host, pool, adapters, DKIM             |
| `sently/sms`             | SMS                                         |
| `sently/whatsapp`        | WhatsApp                                    |
| `sently/push`            | Push (Web Push or FCM)                      |
| `sently/channel-result`  | Shared `{ messageId, provider, accepted }`  |
| `sently/transports/*`    | One provider or decorator per subpath       |
| `sently/webhooks/*`      | Email / SMS / WhatsApp delivery parsers     |

## Documentation

| Resource     | Link                                                         |
| ------------ | ------------------------------------------------------------ |
| Docs site    | [sently.omqkhafi.dev](https://sently.omqkhafi.dev)                   |
| Handbook     | [/docs](https://sently.omqkhafi.dev/docs)                             |
| Get started  | [/docs/get-started](https://sently.omqkhafi.dev/docs/get-started)     |
| Channels     | [/docs/channels](https://sently.omqkhafi.dev/docs/channels)           |
| Transports   | [/docs/transports](https://sently.omqkhafi.dev/docs/transports)       |
| Compare      | [/docs/guides/compare](https://sently.omqkhafi.dev/docs/guides/compare) |
| Agents index | [/llms.txt](https://sently.omqkhafi.dev/llms.txt)                     |
| Changelog    | [`CHANGELOG.md`](CHANGELOG.md)                               |
| Security     | [`SECURITY.md`](SECURITY.md)                                 |
| Agents       | [`AGENTS.md`](AGENTS.md)                                     |

Local docs: `bun run site:dev`. Verify: `bun run verify`.

Semver-stable channel contracts. Published on [npm](https://www.npmjs.com/package/sently) (provenance + Trusted Publishing) and [JSR](https://jsr.io/@omqkhafi/sently). MIT.
