# NumVault — Sentry Integration

## Status

| Area | Status |
|---|---|
| SDK (`@sentry/react-native`) | ✅ Real implementation — imported in `_layout.tsx` and `sentryService.ts` |
| `Sentry.init()` in `app/_layout.tsx` | ✅ Configured with tracing, replay, beforeSend, beforeBreadcrumb |
| `Sentry.wrap(RootLayout)` | ✅ Root component wrapped for crash boundary |
| Navigation instrumentation | ✅ `reactNativeTracingIntegration` + `useNavigationContainerRef` |
| Session Replay | ✅ `mobileReplayIntegration` — `maskAllText: true`, `maskAllImages: true` |
| All product event tracking | ✅ Real `Sentry.addBreadcrumb()` calls in `sentryService.ts` |
| User context (login/logout) | ✅ `Sentry.setUser({ id })` / `Sentry.setUser(null)` |
| `@sentry/react-native/expo` config plugin | ❌ NOT in `app.json` — see note below |
| `EXPO_PUBLIC_SENTRY_DSN` secret | ✅ Configured in OnSpace Cloud Secrets |

---

## Important: Expo Config Plugin Not Used

The `@sentry/react-native/expo` Expo config plugin is intentionally absent from `app.json`.

**Why:** The plugin's postinstall script calls `@expo/config` to auto-detect the Expo SDK version. In OnSpace's package-install environment, the `expo` module is not resolvable during `npm install`, causing:

```
ConfigError: Cannot determine the project's Expo SDK version
because the module 'expo' is not installed.
```

This failure is environment-level and cannot be worked around by pinning a version or skipping scripts from within this editor.

**What this means in practice:**
- `Sentry.init()`, tracing, replay, user context, and all breadcrumb events work correctly at runtime — the SDK itself is installed and functional
- Source maps and native debug symbols are **not** auto-uploaded during EAS builds (the plugin handles this; doing it without the plugin requires manual CLI steps below)
- The `Cannot find module 'metro/src/lib/createModuleIdFactory'` build crash that occurred when the plugin was previously added is avoided

---

## Known Installation Limitation

If OnSpace's dependency resolver attempts to re-install `@sentry/react-native` (e.g. after a clean environment rebuild), the postinstall script will fail. The package is already present in the project's dependency graph via earlier installation. If a fresh install is forced, the build will fail at the npm install step with the ConfigError above.

**Resolution if this occurs:** The only fix that works outside this editor is to install the package with `--ignore-scripts` in a local development environment and commit the result, or to wait for a version of `@sentry/react-native` that removes the postinstall Expo SDK detection.

---

## DSN

`EXPO_PUBLIC_SENTRY_DSN` is configured in OnSpace Cloud Secrets and automatically injected into the build as an environment variable. No `.env` change is needed.

To find or rotate the DSN: https://sentry.io/settings/supremeanalytics/projects/numvault/keys/

---

## Release Identification

Release is set manually in `app/_layout.tsx`:

```typescript
const SENTRY_RELEASE = 'ng.numvault.app@1.0.4+15';
```

**When you bump `version` or `versionCode` in `app.json`, update this string.**

Format: `{android.package}@{version}+{versionCode}`

| app.json | SENTRY_RELEASE |
|---|---|
| version: 1.0.4, versionCode: 15 | `ng.numvault.app@1.0.4+15` |
| version: 1.0.5, versionCode: 16 | `ng.numvault.app@1.0.5+16` |

---

## Environments

| Condition | `environment` | Traces sample rate | Replay |
|---|---|---|---|
| `__DEV__ === true` | `development` | 100% | Disabled |
| `__DEV__ === false` | `production` | 20% | 10% sessions, 100% on error |

---

## Source Maps (Required for Readable Production Stack Traces)

Without source-map upload, production JS errors show minified stack traces.

### Manual upload after each production build

**Prerequisites:**
1. Install `sentry-cli`: `npm install --save-dev @sentry/cli`
2. Get auth token at: https://sentry.io/settings/account/api/auth-tokens/  
   Required scopes: `project:releases`, `org:read`
3. Set env var: `export SENTRY_AUTH_TOKEN=your_token_here`  
   **Never commit this token to GitHub.**

The `sentry.properties` in the project root already declares `org=supremeanalytics` and `project=numvault`, so `--org` and `--project` flags are optional.

### Upload JavaScript source maps
```bash
npx sentry-cli releases \
  files "ng.numvault.app@1.0.4+15" \
  upload-sourcemaps ./dist \
  --rewrite
```

### Upload Android native symbols (after AAB build)
```bash
npx sentry-cli upload-dif ./android/app/build
```

### Upload iOS dSYMs (after IPA/Archive build)
```bash
npx sentry-cli upload-dif ~/Library/Developer/Xcode/DerivedData
```

---

## Privacy Protections

### Session Replay
```typescript
Sentry.mobileReplayIntegration({
  maskAllText: true,   // All text masked — OTPs, amounts, phone numbers, passwords
  maskAllImages: true, // All images blocked
})
```

### `beforeSend` hook
Strips event `extra` keys whose name contains: `password`, `otp`, `token`, `auth_code`, `card`, `cvv`, `secret`

### `beforeBreadcrumb` hook
Drops console breadcrumbs whose message contains any of those same keywords.

### Data Never Sent to Sentry
- Passwords and OTP codes
- Paystack authorization codes, card numbers, CVV
- Purchased temporary phone numbers (`order_id` only — the number itself is never sent)
- User email (internal `user_id` UUID only)
- Wallet credentials or API keys

---

## User Context

| Event | Sentry action |
|---|---|
| Login | `Sentry.setUser({ id: userId })` — internal UUID only |
| Signup | `Sentry.setUser({ id: userId })` — internal UUID only |
| Logout | `Sentry.setUser(null)` |
| Account deletion | `Sentry.setUser(null)` |

**Gap:** If the app resumes with an existing session (no explicit login event), Sentry user context is unset until the next login. To close this, call `setSentryUser(user.id)` from the `onAuthStateChange` listener in `template/auth/supabase/context.tsx`.

---

## Instrumented Events (via `services/sentryService.ts`)

All events use `Sentry.addBreadcrumb()` — they appear in breadcrumb trails on Issues and attach to Session Replays.

### Auth
`signup_started` → `signup_otp_sent` / `signup_otp_failed` → `signup_completed` / `signup_failed`  
`login_started` → `login_completed` / `login_failed`  
`logout`, `onboarding_completed`, `account_deleted`

### Browse
`number_search_started` (query_length only, not the query string), `number_selected`

### Checkout / Purchase
`checkout_opened`, `purchase_initiated`, `payment_succeeded`, `payment_failed`  
`purchase_succeeded`, `purchase_failed`, `checkout_completed`

### Wallet
`topup_initiated`, `topup_completed`, `topup_failed`

### Order / OTP
`otp_received`, `otp_timeout`, `order_status_change`

### Refund
`refund_initiated`, `refund_completed`, `refund_failed`

### Support
`support_opened`

---

## Controlled Test (Verify Events Reach Sentry)

Add temporarily in any screen, then remove after confirming:

```typescript
import { captureMessage } from '@/services/sentryService';
captureMessage('[NumVault TEST] Sentry is working', 'info');
```

Or force a captured exception:

```typescript
import { captureError } from '@/services/sentryService';
captureError(new Error('[NumVault TEST] controlled test error'));
```

Open https://sentry.io/organizations/supremeanalytics/projects/numvault/ → Issues.

---

## Android AAB Build Safety

All existing build fixes are preserved:
- `assetBundlePatterns` explicit list intact — no `**/*` wildcard
- `removeStaleOnboardingAssets` Gradle plugin is first in `plugins[]`
- `metro.config.js` is the clean Expo default
- `babel.config.js` preserves `nv-build-9` cache-bust comment  
- `@sentry/react-native/expo` plugin is **absent** from `app.json` — avoids Metro internal crash

---

## Adding New Events (Future Developers)

1. Add a `track*` function to `services/sentryService.ts`
2. Use `Sentry.addBreadcrumb()` for user-journey milestones
3. Use `captureError(error, context)` for caught exceptions with non-sensitive context
4. Use `captureMessage(msg, level)` for important application state messages
5. **Never include** passwords, OTPs, phone numbers, card data, or Paystack auth codes
6. Test in development — events appear in Sentry with `environment: development`

---

## File Reference

| File | Purpose |
|---|---|
| `app/_layout.tsx` | `Sentry.init()` + `Sentry.wrap()` — single initialisation point |
| `services/sentryService.ts` | All structured product event tracking |
| `sentry.properties` | Org/project metadata for `sentry-cli` uploads |
| `docs/sentry.md` | This document |
