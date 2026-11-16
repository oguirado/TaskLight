# Hosting (U22)

Firebase Hosting site for the hosted context wall. Build with:

```
npx vite build --mode production --config hosting/vite.config.ts
```

Deploy with `firebase deploy --only hosting` (preview channels via
`firebase hosting:channel:deploy CHANNEL_ID`).

## Configuration

Set the App Check site key with the `VITE_RECAPTCHA_SITE_KEY` build variable
(see `hosting/src/main.ts` and `src/app/index.ts`), not
`RECAPTCHA_SITE_KEY_PUBLIC` in `src/app/firebase-config.public.ts`.
App Check debug tokens are for localhost only and must never be committed.

## Embed contract (extension side panel)

- The extension panel embeds this wall in an iframe. The iframe MUST carry
  `allow="language-model"` in static markup together with `src`.
- `allow` set from script after `src` silently yields `unavailable` (S4).
  Always write `allow="language-model"` before `src` in the same markup tag.
- Hosting `frame-ancestors` (see `headers.json`) lists `chrome-extension://`
  origins only, never `*`. The wall arrives embedded; the extension checks
  `event.origin` and `event.source` and replies with the exact origin.
- The extension lists this site in `externally_connectable.matches` for the
  T1 port (`chrome.runtime.connect`); the T2 `postMessage` path uses the
  connector in `src/app/connector.ts`.

## CSP

`index.html` has a CSP meta; `frame-ancestors` is an HTTP header since meta
cannot set it. `script-src` is `'self'` plus the reCAPTCHA and Auth script
origins; `connect-src` lists the Firebase/Google endpoints the wall needs.
The `hosting/headers.json` header mirrors the meta and adds `script-src` and
`frame-ancestors`. `localhost` is never a reCAPTCHA domain.

## Debug tokens

The App Check debug token comes only from uncommitted `.env.local` in dev.
It is never in source, never in `firebase-config.public.ts`, and the Vite
production build strips it (see `vite.config.ts`).
