/**
 * NumVault — Sentry observability service (stub)
 *
 * @sentry/react-native cannot be installed in the OnSpace build environment
 * because its postinstall script calls @expo/config before `expo` is
 * resolvable, which causes a ConfigError at install time.
 *
 * All functions are no-ops so every call site compiles and runs unchanged.
 * When Sentry becomes available outside this environment, replace this file
 * with the real implementation (preserved in docs/sentry.md).
 *
 * Privacy rules still documented here for future implementation:
 *  - No passwords, OTPs, card numbers, CVV, or Paystack auth codes
 *  - No full phone numbers (purchased temporary numbers are NEVER sent)
 *  - No wallet credentials or API keys
 *  - User is identified by internal ID only
 */

// ─── User context ─────────────────────────────────────────────────────────────

export function setSentryUser(_userId: string) { /* stub */ }
export function clearSentryUser() { /* stub */ }

// ─── Auth events ──────────────────────────────────────────────────────────────

export function trackSignupStarted() { /* stub */ }
export function trackSignupOtpSent(_success: boolean, _errorMessage?: string) { /* stub */ }
export function trackSignupCompleted(_userId: string) { /* stub */ }
export function trackSignupFailed(_reason: string) { /* stub */ }
export function trackLoginStarted() { /* stub */ }
export function trackLoginCompleted(_userId: string) { /* stub */ }
export function trackLoginFailed(_reason: string) { /* stub */ }
export function trackOnboardingCompleted() { /* stub */ }
export function trackLogout() { /* stub */ }
export function trackAccountDeleted() { /* stub */ }

// ─── Number search / service browse events ────────────────────────────────────

export function trackSearchStarted(_query: string) { /* stub */ }
export function trackServiceSelected(_serviceName: string, _provider: string) { /* stub */ }

// ─── Checkout / purchase events ───────────────────────────────────────────────

export function trackCheckoutOpened(_serviceName: string, _priceNgn: number, _fromWallet: boolean) { /* stub */ }
export function trackPurchaseInitiated(_serviceName: string, _priceNgn: number, _method: 'wallet' | 'paystack') { /* stub */ }
export function trackPaymentSucceeded(_priceNgn: number, _method: 'wallet' | 'paystack') { /* stub */ }
export function trackPaymentFailed(_reason: string, _method: 'wallet' | 'paystack') { /* stub */ }
export function trackPurchaseSucceeded(_serviceName: string, _orderId: string) { /* stub */ }
export function trackPurchaseFailed(_serviceName: string, _reason: string) { /* stub */ }
export function trackCheckoutCompleted(_serviceName: string, _priceNgn: number) { /* stub */ }

// ─── Wallet events ────────────────────────────────────────────────────────────

export function trackWalletTopupInitiated(_amountNgn: number, _method: 'saved_card' | 'paystack') { /* stub */ }
export function trackWalletTopupCompleted(_amountNgn: number) { /* stub */ }
export function trackWalletTopupFailed(_reason: string) { /* stub */ }

// ─── Refund events ────────────────────────────────────────────────────────────

export function trackRefundInitiated(_orderId: string) { /* stub */ }
export function trackRefundCompleted(_orderId: string, _amountNgn: number) { /* stub */ }
export function trackRefundFailed(_orderId: string, _reason?: string) { /* stub */ }

// ─── Order status events ──────────────────────────────────────────────────────

export function trackOrderStatusChange(_orderId: string, _newStatus: string) { /* stub */ }
export function trackOtpReceived(_orderId: string) { /* stub */ }
export function trackOtpTimeout(_orderId: string) { /* stub */ }

// ─── Support interaction ──────────────────────────────────────────────────────

export function trackSupportInteraction(_source: string) { /* stub */ }

// ─── Error capturing ──────────────────────────────────────────────────────────

export function captureError(_error: unknown, _context?: Record<string, unknown>) { /* stub */ }
export function captureMessage(_message: string, _level?: string) { /* stub */ }
