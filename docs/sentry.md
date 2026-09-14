# NumVault — Sentry Integration Guide

## Overview

Sentry is integrated into NumVault via `@sentry/react-native`. It provides crash monitoring, error tracking, performance tracing, Session Replay, structured event breadcrumbs, and custom metrics for all key user journeys.

---

## Environments

| Environment | Value | Sentry traces sample rate | Replay |
|---|---|---|---|
| Development (`__DEV__ = true`) | `development` | 100% | Disabled |
| Production | `production` | 20% | 10% sessions, 100% on error |

---

## Release Strategy

- Release is set **manually** in `app/_layout.tsx` as `ng.numvault.app@{version}+{versionCode}`.
- When you bump `version` or `versionCode` in `app.json`, update the `release` string in `Sentry.init()` to match.
- Current value: `ng.numvault.app@1.0.4+15`

**Why manual?** The `@sentry/react-native/expo` Expo config plugin (which auto-injects the release) was removed because its postinstall script requires `expo` to be resolvable during `npm install`, which fails in the OnSpace build environment.

---

## Source Maps and Native Symbols

The Sentry Expo config plugin is **not** used. This means:

- Source maps are **not** automatically uploaded during builds.
- JavaScript errors in production will show minified stack traces unless maps are uploaded manually.

To upload source maps after a production build:
```bash
npx sentry-cli releases files "ng.numvault.app@1.0.4+15" upload-sourcemaps ./dist
```

To upload native debug symbols (Android ProGuard / iOS dSYMs):
```bash
npx sentry-cli upload-dif ./android/app/build --org supremeanalytics --project numvault
```

Both commands require `SENTRY_AUTH_TOKEN` to be set in the environment. **Never commit this token to git.**

---

## Required Environment Variables

### In `.env` (client-side, embedded in app bundle — this is the Sentry DSN, which is not secret):
```
EXPO_PUBLIC_SENTRY_DSN=https://YOUR_KEY@oXXXXXX.ingest.sentry.io/XXXXXXX
```

Retrieve your DSN from:
**https://sentry.io/settings/supremeanalytics/projects/numvault/keys/**

### For source-map uploads only (NOT in `.env`, NOT committed to git):
```
SENTRY_AUTH_TOKEN=your_sentry_auth_token
```

To get a Sentry auth token:
1. Go to https://sentry.io/settings/account/api/auth-tokens/
2. Create a token with `project:releases` and `org:read` scopes.

---

## Sentry Project Configuration

- **Organization**: `supremeanalytics`
- **Project**: `numvault`
- **DSN source**: https://sentry.io/settings/supremeanalytics/projects/numvault/keys/

---

## SDK Notes

- `@sentry/react-native` Custom Metrics API (`Sentry.metrics.increment`, `Sentry.metrics.distribution`) was **deprecated and removed by Sentry in October 2024** (affects SDK v6+). All metric tracking in `sentryService.ts` uses `Sentry.addBreadcrumb()` instead — fully compatible and searchable in Sentry Issues.
- `Sentry.wrap(RootLayout)` is applied in `app/_layout.tsx` — this is the correct single-init point.
- `Sentry.mobileReplayIntegration()` is included for Session Replay.
- `Sentry.reactNativeTracingIntegration()` is included for navigation + API performance tracing.

---

## Instrumented Events

All events use `Sentry.addBreadcrumb()`. They attach to errors and replays, and appear in breadcrumb trails in Sentry Issues.

### Auth
`signup_started`, `signup_otp_sent`, `signup_completed`, `signup_failed`, `login_started`, `login_completed`, `login_failed`, `logout`, `onboarding_completed`, `account_deleted`

### Checkout / Purchase
`checkout_opened`, `purchase_initiated`, `payment_succeeded`, `payment_failed`, `purchase_succeeded`, `purchase_failed`, `checkout_completed`

### Wallet
`topup_initiated`, `topup_completed`, `topup_failed`

### Order / OTP
`otp_received`, `otp_timeout`, `order_status_change`, `refund_initiated`, `refund_completed`, `refund_failed`

### Support
`support_opened`

---

## Session Replay Privacy Configuration

Session Replay is configured with **maximum privacy protection**:

```typescript
Sentry.mobileReplayIntegration({
  maskAllText: true,    // ALL text masked — passwords, OTPs, amounts, phone numbers
  maskAllImages: true,  // ALL images blocked
})
```

No readable text from any screen appears in Sentry replays. This is intentional — NumVault handles sensitive payment and SMS data.

---

## Privacy Protections

The following data is **never** sent to Sentry:

- Passwords and OTP codes
- Paystack authorization codes or secrets
- Card numbers, CVV, expiry dates
- Wallet credentials or API keys
- Purchased temporary phone numbers (order_id only)
- User emails (only internal `user_id` via `Sentry.setUser({ id })`)

The `beforeSend` hook strips any event extra/context key containing: `password`, `otp`, `token`, `auth_code`, `card`, `cvv`, `secret`.

The `beforeBreadcrumb` hook drops console breadcrumbs containing those keywords.

---

## User Context Management

- **On login**: `trackLoginCompleted(userId)` → `setSentryUser(userId)`
- **On signup**: `trackSignupCompleted(userId)` → `setSentryUser(userId)`
- **On logout**: `trackLogout()` → `clearSentryUser()`
- **On account deletion**: `trackAccountDeleted()` → `clearSentryUser()`

Note: If the app resumes with an existing session (no login event fired), Sentry user context will be unset until the next login. For permanent context, consider calling `setSentryUser` from the auth state change listener in `AuthProvider`.

---

## Testing Sentry

### Test a JavaScript error (development only — remove after testing)
```typescript
import * as Sentry from '@sentry/react-native';
// In any button handler:
Sentry.captureException(new Error('[NumVault TEST] Manual Sentry test error'));
```

### Verify in dashboard
1. Open https://sentry.io/organizations/supremeanalytics/projects/numvault/
2. Check **Issues** for the test error
3. Check **Performance** → **Transactions** for navigation events
4. Check **Replays** for session recordings (production only)

---

## Android AAB Build Compatibility

All existing Android build fixes are preserved:
- `assetBundlePatterns` remains the explicit list — no `**/*` wildcard
- `removeStaleOnboardingAssets` Gradle plugin is intact
- `metro.config.js` is the clean Expo default
- `babel.config.js` preserves the `nv-build-9` cache-bust

The Sentry SDK has **no** Expo config plugin — no additional Gradle tasks are injected.

---

## Updating the Release String

When you increment `version` or `versionCode` in `app.json`, update this line in `app/_layout.tsx`:

```typescript
release: 'ng.numvault.app@1.0.4+15',
```

Format: `{android.package}@{version}+{versionCode}`

Example for version 1.0.5 / versionCode 16: `ng.numvault.app@1.0.5+16`

---

## Adding New Sentry Events (for future developers)

1. Add a new `track*` function to `services/sentryService.ts`
2. Use `Sentry.addBreadcrumb()` for user-journey steps
3. Use `captureError(error, context)` for caught exceptions with non-sensitive context
4. **Never include** passwords, OTPs, phone numbers, card data, or auth codes
5. Test in development (`__DEV__ === true`) — events will appear in Sentry with environment `development`
