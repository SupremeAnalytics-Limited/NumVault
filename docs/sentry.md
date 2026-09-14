# NumVault — Sentry Integration

## Status

| Area | Status |
|---|---|
| SDK installed (`@sentry/react-native`) | ❌ Cannot install in OnSpace (postinstall conflict) |
| `sentryService.ts` call sites preserved (stubs) | ✅ All functions are no-ops — zero call-site changes |
| `Sentry.init()` in `app/_layout.tsx` | ❌ Removed (requires SDK) |
| `@sentry/react-native/expo` plugin in `app.json` | ❌ Removed (causes install failure) |
| `sentry.properties` (org/project for CLI uploads) | ✅ Present |
| All event tracking functions | ✅ Stubbed — ready to activate once SDK installs |

---

## Expo Config Plugin

The `@sentry/react-native/expo` Expo config plugin is included in `app.json` with:
- `organization: supremeanalytics`
- `project: numvault`
- `enableMetroModuleIdFactory: false` — disables the legacy Metro internal API usage that caused the `Cannot find module 'metro/src/lib/createModuleIdFactory'` build failure

Without `enableMetroModuleIdFactory: false`, the plugin's auto-discovered Metro serializer attempts to import the removed `metro/src/lib/createModuleIdFactory` internal path (removed in Metro 0.80+), which crashes `createBundleReleaseJsAndAssets` before any JS is produced.

---

## Step 1: DSN

`EXPO_PUBLIC_SENTRY_DSN` is configured in OnSpace Cloud Secrets and automatically injected into the build. No manual `.env` change required.

To find your DSN: https://sentry.io/settings/supremeanalytics/projects/numvault/keys/

---

## Step 2: Verify It Works

In any screen, temporarily add a test capture (remove after testing):

```typescript
import * as Sentry from '@sentry/react-native';
Sentry.captureException(new Error('[NumVault TEST] Sentry working'));
```

Open https://sentry.io/organizations/supremeanalytics/projects/numvault/ and confirm the event appears under **Issues**.

---

## Environments and Release

| Environment | `__DEV__` | Traces sample rate | Replay |
|---|---|---|---|
| Development | `true` | 100% | Disabled |
| Production | `false` | 20% | 10% sessions, 100% on error |

Release is set manually in `app/_layout.tsx`:
```typescript
release: 'ng.numvault.app@1.0.4+15',
```

**When you bump `version` or `versionCode` in `app.json`, update this string to match.**

Format: `{android.package}@{version}+{versionCode}`
Example for 1.0.5 / versionCode 16: `ng.numvault.app@1.0.5+16`

---

## Source Maps (Production JavaScript Errors)

Without source-map upload, production JS errors show minified stack traces. Upload after each production build:

### Prerequisites

The `@sentry/react-native/expo` plugin automatically uploads source maps during EAS builds **if** `SENTRY_AUTH_TOKEN` is set as a build secret.

1. Get a token at: https://sentry.io/settings/account/api/auth-tokens/  
   Required scopes: `project:releases`, `org:read`
2. Add it to OnSpace Cloud Secrets as `SENTRY_AUTH_TOKEN` (**never commit this token**)

For manual CLI uploads:  
```bash
npm install --save-dev @sentry/cli
export SENTRY_AUTH_TOKEN=your_token_here
```

### Upload JavaScript source maps
```bash
npx sentry-cli releases \
  --org supremeanalytics \
  --project numvault \
  files "ng.numvault.app@1.0.4+15" \
  upload-sourcemaps ./dist \
  --rewrite
```

### Upload Android native symbols (after AAB build)
```bash
npx sentry-cli upload-dif \
  --org supremeanalytics \
  --project numvault \
  ./android/app/build
```

### Upload iOS dSYMs (after IPA build)
```bash
npx sentry-cli upload-dif \
  --org supremeanalytics \
  --project numvault \
  ~/Library/Developer/Xcode/DerivedData
```

The `sentry.properties` file in the project root already contains `org=supremeanalytics` and `project=numvault`, so `sentry-cli` will pick these up automatically without the `--org` and `--project` flags.

---

## Privacy Protections

### Session Replay
```typescript
Sentry.mobileReplayIntegration({
  maskAllText: true,   // ALL text masked — OTPs, amounts, phone numbers, passwords
  maskAllImages: true, // ALL images blocked
})
```

### Data Never Sent to Sentry
- Passwords and OTP codes
- Paystack authorization codes, card numbers, CVV
- Purchased temporary phone numbers (order_id only)
- User email (internal `user_id` only via `Sentry.setUser({ id })`)
- Wallet credentials or API keys

### `beforeSend` hook
Strips event `extra` keys containing: `password`, `otp`, `token`, `auth_code`, `card`, `cvv`, `secret`

### `beforeBreadcrumb` hook
Drops console breadcrumbs whose message contains those same keywords.

---

## User Context

| Event | Action |
|---|---|
| Login | `setSentryUser(userId)` — internal UUID only |
| Signup | `setSentryUser(userId)` — internal UUID only |
| Logout | `clearSentryUser()` |
| Account deletion | `clearSentryUser()` |

Note: If the app resumes from background with an existing session (no login event fired), Sentry user context is unset until the next explicit login. To fix this permanently, call `setSentryUser(user.id)` from the `onAuthStateChange` listener in the auth provider.

---

## Instrumented Events

All events use `Sentry.addBreadcrumb()`. They appear in breadcrumb trails in Sentry Issues and attach to replays.

### Auth
`signup_started` → `signup_otp_sent` → `signup_completed` / `signup_failed`
`login_started` → `login_completed` / `login_failed`
`logout`, `onboarding_completed`, `account_deleted`

### Search / Browse
`number_search_started` (query_length only, not content), `number_selected`

### Checkout / Purchase
`checkout_opened`, `purchase_initiated`, `payment_succeeded`, `payment_failed`
`purchase_succeeded`, `purchase_failed`, `checkout_completed`

### Wallet
`topup_initiated`, `topup_completed`, `topup_failed`

### Order / OTP
`otp_received`, `otp_timeout`, `order_status_change`, `refund_initiated`, `refund_completed`, `refund_failed`

### Support
`support_opened`

---

## Android AAB Build Safety

All existing build fixes are preserved:
- `assetBundlePatterns` explicit list intact — no `**/*` wildcard
- `removeStaleOnboardingAssets` Gradle plugin is first in `plugins[]` — runs before Sentry plugin
- `metro.config.js` is the clean Expo default (Sentry Metro serializer is disabled via `enableMetroModuleIdFactory: false`)
- `babel.config.js` preserves `nv-build-9` cache-bust comment
- `enableMetroModuleIdFactory: false` prevents Sentry from injecting the legacy Metro internal that broke `createBundleReleaseJsAndAssets`

---

## Adding New Events (Future Developers)

1. Add a `track*` function to `services/sentryService.ts`
2. Use `Sentry.addBreadcrumb()` for user-journey steps
3. Use `captureError(error, context)` for caught exceptions with non-sensitive context
4. **Never include** passwords, OTPs, phone numbers, card data, or Paystack auth codes
5. Test in development — events appear in Sentry with `environment: development`

---

## File Reference

| File | Purpose |
|---|---|
| `app/_layout.tsx` | `Sentry.init()` + `Sentry.wrap()` — single init point |
| `services/sentryService.ts` | All structured event tracking functions |
| `sentry.properties` | Org/project config for `sentry-cli` uploads |
| `docs/sentry.md` | This document |
| `.env` | `EXPO_PUBLIC_SENTRY_DSN=...` **(you must add this)** |
