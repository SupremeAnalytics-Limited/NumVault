# NumVault — Developer Notes

**Period covered:** 21–23 September 2026
**Summary:** NumVault moved off OnSpace onto its own Supabase backend, was hardened, rebuilt for iOS (TestFlight) and Android (new Play listing), and the ambassador programme gained checkpoints, countdowns and corrected notifications.

No secrets are recorded here. Keys live in Supabase → Edge Functions → Secrets, in EAS credentials, and in the Paystack / Socially.ng / Zoho / Firebase dashboards.

---

## 1. Where everything lives now

| Piece | Location |
|---|---|
| Code | GitHub `SupremeAnalytics-Limited/NumVault`, branch **`main`** |
| Old OnSpace code (backup) | branch `onspace-legacy` (untouched) |
| Backend | Supabase project `xiklcfiobtvjzjanqpqw` (eu-west-2, free plan) |
| Builds | EAS project `@supremeesimon/numvault` (id `9194c8f5-1135-43b2-8564-ea3c67f4ea68`) |
| iOS | Bundle `ng.numvault.app`, App Store Connect app id `6814984686` |
| Android | Package **`cloud.numvault.app`** (new listing; the old `ng.numvault.app` internal-test app was deleted) |
| Push (Android) | Firebase project `numvault-cloud`, FCM V1 key uploaded to EAS |
| Email | Zoho Mail (Canada data centre) → Supabase custom SMTP |
| Payments | Paystack (webhook points at Supabase) |
| Numbers | Socially.ng API |

`main` was fast-forwarded to the migration branch (no force push). `claude/onspace-backend-connections-l35v73` still exists and equals `main`; it can be deleted.

Integrations: Expo ↔ GitHub connected. Supabase ↔ GitHub: working directory `.`, production branch `main`, **Deploy to production OFF** (see §9).

---

## 2. Backend migration (OnSpace → Supabase)

### Schema
`supabase/migrations/` holds the whole database. File names match the versions recorded on the live project:

| File | What it does |
|---|---|
| `20260922230357_numvault_baseline.sql` | 10 tables, RLS, column grants, money routines, ambassador logic |
| `20260923011629_qualification_checkpoints.sql` | Checkpoints at 19/38/57 (§5) |
| `20260923095912_otp_result_block_number.sql` | `complete_order_with_otp` also returns `block_number` |
| `20260923124859_block_test_robot_signups.sql` | Auth hook refusing Google's test-robot sign-ups |

Key rules in the baseline:
- **RLS everywhere.** Users read only their own rows; the admin (`is_admin()`, by email) can read all.
- **Column grants.** Users can update only `name`, `username`, `push_token` on their profile. Nobody can change `wallet_balance` from the app.
- **Money routines are `SECURITY DEFINER` and callable only by `service_role`:**
  - `debit_wallet`
  - `credit_wallet` (idempotent: a unique index on credit `reference`, so one credit per payment or refund)
  - `process_order_expiry` (refuses to refund within 5 minutes)
  - `complete_order_with_otp`
  - `close_expired_blocks` / `close_all_expired_blocks`
- `handle_new_user` trigger creates `user_profiles` rows.
- The app can call only `enroll_in_program(name)` and `reenroll_in_program()`.

### Data import
Imported from OnSpace CSV exports:
- 7 accounts, total wallet ₦2,912.87
- 5 ambassadors, 6 pitches, 23 orders, 61 transactions, 9 Socially transfers
- 1 purchase lock and 1 ledger entry

One duplicate refund was renamed with a `_duplicate_refund_…` suffix so the unique credit index holds. Auth users were inserted with their original ids, so Paystack metadata `user_id` still matches.

Before deleting OnSpace, Paystack was reconciled: the only successful payment after the export (21 Sep, Snapchat ₦2,290) is present as an order plus transaction. One OnSpace-only account with no successful payment (an abandoned TikTok checkout) was not carried over; that person can simply sign up again.

**OnSpace does not export passwords.** Every migrated user signs in once with **Forgot password?** (6-digit email code → new password).

### Edge functions (deployed)
- `paystack-webhook` (`verify_jwt = false`, HMAC-SHA512 signature check)
- `socially-proxy` (the app may only read the catalogue; no absolute URLs)
- `purchase-number`, `wallet-topup`
- `confirm-otp`, `expire-order`, `auto-expire-orders`
- `ensure-socially-balance`
- `apply-referral-code`, `close-blocks`, `approve-payout`, `admin-withdrawable`, `create-transfer-recipient`
- `delete-account`, `notify-admin`

Deliberately **not deployed:** `manual-transfer-test`, `save-card`, `setup-subaccount`, `sms-webhook`.

### Security fixes vs OnSpace
- The webhook now verifies Paystack's signature. Fake webhooks and the `x-webhook-user-id` bypass return 401.
- Top-ups and refunds go through `credit_wallet`, so double webhooks and double refunds can't double-credit.
- The app can no longer buy through the proxy or read OTPs directly. OTPs are released only by `confirm-otp`, which completes the order at the same time, so a customer can't read a code and still get refunded.
- Expiry: if an OTP arrived, the order is **completed** instead of refunded (`_shared/socially-otp.ts`).
- The 30-day window no longer counts customers who arrive late.

### Secrets (names only)
`PAYSTACK_SECRET_KEY` (rotated after leaving OnSpace), `SOCIALLY_API_TOKEN` (rotated; verified working), `SOCIALLY_SUBACCOUNT_CODE`.

### Scheduled jobs (pg_cron, see `supabase/setup/cron.sql`)
- `auto-expire-orders`: every minute. Calls the edge function with the anon key via Vault secrets `project_url` / `function_key`. It also triggers the Socially balance check.
- `close-expired-blocks`: hourly at :07. Runs `close_all_expired_blocks()`.

### Auth / email
- Custom SMTP: Zoho, host `smtp.zohocloud.ca`, port 465, user `support@numvault.cloud`. It needs a Zoho **app password**, which required enabling Zoho MFA first.
- Templates **Magic link / OTP** and **Confirm sign up** show `{{ .Token }}`, not a link.
- **Email OTP length = 6.** The app accepts exactly 6 digits.
- Site URL `https://numvault.cloud`; redirect `numvault://auth`.
- **Before User Created hook** → `public.block_test_robot_signups` refuses `crawlerrobo@gmail.com`, `cloudtestlab*@gmail.com` and `*@cloudtestlabaccounts.com`. Google's pre-launch robot used full inboxes, so every code email bounced.
- Store-review test account: **support@numvault.cloud** (password held by the owner). It's entered in Play Console "Sign in details"; add it to App Store Connect → App Review Information too.

---

## 3. Paystack

- **Live webhook:** `https://xiklcfiobtvjzjanqpqw.supabase.co/functions/v1/paystack-webhook`, switched from OnSpace on 23 Sep.
- **Pricing:** retail = wholesale + ₦1,500 (`constants/config.ts`).
- **Fees:** "pass charges to customer" is on in the dashboard, so customers pay the Paystack fee on top and NumVault keeps exactly ₦1,500. Verified on real transactions. The code still sends `bearer: 'account'`; the dashboard setting wins.
- **Splits:**
  - Direct number purchase: `transaction_charge` = ₦1,500 to NumVault; the subaccount (Socially.ng's PalmPay) receives the exact wholesale. Settles T+1.
  - Wallet top-up: subaccount `percentage_charge` 71.43% goes to Socially.ng up front.
- **Business account is still "starter"**, so Paystack **transfers are blocked** until compliance approves. This blocks both Lead payouts and the automatic Socially top-up.

---

## 4. Socially.ng adaptive top-up (`ensure-socially-balance`)

It runs after purchases and every minute via cron:
- Triggers only when the Socially.ng balance is **below ₦40,000**.
- Sends **1.5×** the last hour's wholesale spend, rounded up to ₦1,000. Minimum **₦40,000**, maximum **₦200,000** per transfer.
- Waits **5 minutes** between top-ups (was 30). A pending transfer always blocks the next one.
- Holds back the payout reserve (payouts owed plus what Leads have accrued) before sending.
- Alerts the admin at ≤ ₦15,000, on a partial top-up, and on failure.
- Capacity is about 12 top-ups an hour, roughly 3,000 numbers an hour at ₦800 wholesale. A simulation showed zero failed purchases up to 1,500 an hour (with 30 minutes, 116 failed at 700 an hour).

**Status:** it has never successfully transferred. All 9 historical attempts failed: 8 with "balance not enough" and 1 with "bank invalid". Transfers are also blocked by the starter account.

**Overlap to fix later:** with the splits on *and* the top-up on, Socially.ng is paid twice for the same numbers (the top-up advance today, plus the split reimbursement tomorrow). About one day's wholesale ends up parked at Socially.ng.

Plan:
1. Get Paystack transfers approved.
2. Test the top-up with a small amount.
3. Lower both splits to 0% in steps, so all money lands in Paystack and the top-up is the only way Socially.ng is paid.

---

## 5. Ambassador programme changes

Rules for reference:
- **Qualifying:** 76 validated customers within 30 days, unpaid.
- **At 76:** the ambassador becomes a Customer Acquisition Lead and Month 1 starts immediately.
- **Paid months:** ₦50k at customer 38 and ₦50k at 76, and the next month starts immediately.
- **A month ending before 76:** paid pro rata at ₦100,000 / 76 per customer, then the Lead must re-qualify.
- **Limits:** 6 paid months maximum (₦600k). Every payout waits for admin approval.
- **Counting:** a validated customer is the first paid number of a unique normalised email, and self-referral is blocked.

New today:
- **Checkpoints (qualifying only):** progress is saved at 19 / 38 / 57. If 30 days end below 76, the ambassador keeps the last checkpoint and a new 30-day window starts automatically; the start date rolls forward in 30-day steps. Below 19 the count resets and they must re-enroll. Column: `acquisition_participants.qualification_carried_over`. There's no limit on roll-overs (a cap was discussed, not added).
- **Paid Leads unchanged:** no carry-over; motivated by money accruing on the dashboard.
- **Screen (`app/acquisition-program.tsx`):**
  - live countdown ("12d 07h 43m 15s") on the qualifying card and the paid-month card
  - checkpoint bar with tappable locks and an ⓘ explainer
  - "carried over" banner
  - sharing paused when re-enrolment is needed
- **Wording:** "validated customers" everywhere. "At 76 you are brought on as a Customer Acquisition Lead for the company…".
- **Notifications:**
  - checkpoint reached (19/38/57)
  - "New 30 days started — N kept"
  - paid-month messages ("✅ Half of Month N complete", "🏆 Month N complete! Month N+1 starts now", "🏆 Month 6 complete")
  - the admin block-closed push only for paid months
- **Bug fixed:** in paid months, *every* customer sent the Lead "76 customers reached" and the admin "qualified as an ambassador" (127 false alerts in simulation). `complete_order_with_otp` now returns `block_number` and `confirm-otp` branches on it.

**Known gap:** the "New 30 days started" push only fires when the ambassador next opens the app, via `close-blocks`. The hourly cron rolls the window but sends no push.

---

## 6. App changes (React Native / Expo SDK 53)

- `.env` points at the new Supabase URL and anon key. The Google OAuth scheme was changed to `numvault`.
- **Login:** accepts 6-digit codes (was 4).
- **Wallet ₦0 bug for the admin:** `fetchProfile()` used an unfiltered `.single()`, and the admin can read every profile. It now filters by the signed-in user id.
- **Over-the-air updates:** `expo-updates` ~0.28.18, `runtimeVersion` policy `appVersion`, channels `production` / `preview`. Ship JS-only fixes with `eas update --channel production --message "…"`. Free tier: 1,000 monthly active users.
- **Removed 103 unused packages** (Stripe and other leftovers from the OnSpace template), which cleared Apple's ITMS-90683 purpose-string rejection. The side-effect import `react-native-url-polyfill/auto` is kept.

### Build fixes
- `eas.json` production iOS uses `image: latest` (Xcode 26, ITMS-90725).
- `plugins/fixFmtConsteval.js` patches `FMT_USE_CONSTEVAL` for Xcode 26.
- `.npmrc` has `legacy-peer-deps=true`, and `ajv@^8` is pinned as a devDependency.
- `ITSAppUsesNonExemptEncryption: false`.
- **Android API 36:** `expo-build-properties` sets compile/target SDK 36 and build tools 36.0.0. `plugins/suppressCompileSdkWarning.js` tells AGP 8.8 that compileSdk 36 is intended.
- `google-services.json` is committed (a public identifier) and referenced by `android.googleServicesFile`.

---

## 7. Verification done

**Live-database simulation** (single transaction, rolled back; 208 fake customers): **17 of 17 checks passed.**
- enrol and get a code; self-referral and unknown codes rejected
- Paystack credit counted once, even on a duplicate webhook; overspend refused
- purchase and OTP complete; double completion blocked; a repeat purchase isn't counted twice
- no OTP → refund after 5 minutes, once only, never early
- Gmail dot/plus duplicates count once
- rollover 25 → 19 kept
- 76 → Lead with no payout; Month 1 creates ₦50k + ₦50k under review and Month 2 starts at once
- Month 2 ending at 50 → ₦65,789.47 total, then re-qualify; re-enrol keeps 2 months done

After the fix, the notification check showed exactly one "76 reached", one admin "qualified", one "half of month" and one "month complete".

**Other checks:**
- Security: forbidden proxy paths return 403/400, and fake webhooks return 401.
- RLS: a user sees only their own rows.
- Socially token: the catalogue returns 200, and the balance check reads correctly.
- The robot-signup hook refuses a test robot address (403, no user created).
- 11 sample `[TEST]` notifications were delivered to the admin's phone.

**Not yet verified:** a real ₦100 wallet top-up with the rotated Paystack key; a real Socially.ng number purchase on the new backend.

---

## 8. Business notes from today's discussion

- Margin is ₦1,500 per number; a Lead earns about ₦1,316 per validated customer, first purchase only. Every paid customer covers their own payout, qualifying customers pay nothing out, and repeat purchases are pure margin.
- Buying fake customers loses money: the cheapest number (≥ ₦1,500) costs more than a Lead earns per customer (₦1,316).
- **1,000 customers:** early days (nobody qualified yet) keeps about ₦1.5M; a mix with about 3 paid Leads keeps about ₦710k.
- **Scaling to thousands of users will need:**
  - Paystack transfers approved
  - a transactional email provider (e.g. Resend) instead of Zoho for login codes
  - Supabase Pro once past ~30k monthly users
  - a paid Expo plan past 1,000 OTA users
  - fixing the Socially.ng split overlap
  - checking Socially.ng can handle the volume

---

## 9. Gotchas

- **Keep Supabase "Deploy to production" off** until a `supabase/config.toml` exists with `[functions.paystack-webhook] verify_jwt = false`. A default redeploy would re-enable the JWT check and every Paystack payment would stop crediting wallets.
- **Migration file names must match the live versions** (`list_migrations`), or the GitHub integration would try to re-run them.
- After `npm install`, `package-lock.json` often changes locally and blocks `git pull`. Fix with `git checkout -- package-lock.json`.
- Always `git pull` and check `git log --oneline -1` before `eas build`. Two builds went out on stale code this week.
- iOS keeps `ng.numvault.app`; Android is `cloud.numvault.app`. Don't unify them.
- Google's robot accounts (`crawlerrobo`, `cloudtestlab…`) are expected after every Play upload.
- Don't run `npm audit fix --force`; it breaks the Expo SDK 53 dependency set.

---

## 10. Open items

1. Delete the OnSpace project (data reconciled; safe).
2. Real ₦100 top-up to confirm the rotated Paystack key and webhook.
3. Upload Android .aab (API 36) and finish Play's "Set up your app" list:
   - privacy policy URL
   - data safety
   - content rating
   - account-deletion URL
   - store listing
4. Submit iOS for App Store review with the support@numvault.cloud login.
5. Paystack compliance → enable transfers → test the Socially top-up → lower splits to 0%.
6. Optional:
   - push the "New 30 days started" notification from the hourly job
   - cap on checkpoint roll-overs
   - admin warning for unusually fast Lead months
   - Android monochrome notification icon
   - delete the `claude/…` branch
