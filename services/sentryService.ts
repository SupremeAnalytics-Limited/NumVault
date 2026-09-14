/**
 * NumVault — Sentry observability service
 *
 * All structured product-telemetry calls go through this module.
 * Sentry is initialised once in app/_layout.tsx; this file adds
 * breadcrumbs, user context, and captures errors for key user journeys.
 *
 * Privacy rules (strictly enforced):
 *  - NEVER send: passwords, OTPs, card numbers/CVV, Paystack auth codes
 *  - NEVER send purchased temporary phone numbers (use orderId only)
 *  - NEVER send wallet credentials or private API keys
 *  - User is identified by internal UUID only (no email, no name)
 */

import * as Sentry from '@sentry/react-native';

// ─── User context ─────────────────────────────────────────────────────────────

/** Call after login/signup with the internal Supabase user ID only. */
export function setSentryUser(userId: string) {
  Sentry.setUser({ id: userId });
}

/** Call on logout and account deletion to stop associating events with the user. */
export function clearSentryUser() {
  Sentry.setUser(null);
}

// ─── Auth events ──────────────────────────────────────────────────────────────

export function trackSignupStarted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_started', level: 'info' });
}

export function trackSignupOtpSent(success: boolean, errorMessage?: string) {
  Sentry.addBreadcrumb({
    category: 'auth',
    message: success ? 'signup_otp_sent' : 'signup_otp_failed',
    level: success ? 'info' : 'warning',
    data: success ? undefined : { reason: errorMessage },
  });
}

export function trackSignupCompleted(userId: string) {
  setSentryUser(userId);
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_completed', level: 'info' });
}

export function trackSignupFailed(reason: string) {
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_failed', level: 'error', data: { reason } });
}

export function trackLoginStarted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_started', level: 'info' });
}

export function trackLoginCompleted(userId: string) {
  setSentryUser(userId);
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_completed', level: 'info' });
}

export function trackLoginFailed(reason: string) {
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_failed', level: 'error', data: { reason } });
}

export function trackOnboardingCompleted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'onboarding_completed', level: 'info' });
}

export function trackLogout() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'logout', level: 'info' });
  clearSentryUser();
}

export function trackAccountDeleted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'account_deleted', level: 'info' });
  clearSentryUser();
}

// ─── Number search / service browse ───────────────────────────────────────────

/** Only the query length is sent — never the query string content. */
export function trackSearchStarted(query: string) {
  Sentry.addBreadcrumb({
    category: 'browse',
    message: 'number_search_started',
    level: 'info',
    data: { query_length: query.length },
  });
}

export function trackServiceSelected(serviceName: string, provider: string) {
  Sentry.addBreadcrumb({
    category: 'browse',
    message: 'number_selected',
    level: 'info',
    data: { service: serviceName, provider },
  });
}

// ─── Checkout / purchase ──────────────────────────────────────────────────────

export function trackCheckoutOpened(serviceName: string, priceNgn: number, fromWallet: boolean) {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'checkout_opened',
    level: 'info',
    data: { service: serviceName, price_ngn: priceNgn, from_wallet: fromWallet },
  });
}

export function trackPurchaseInitiated(serviceName: string, priceNgn: number, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'purchase_initiated',
    level: 'info',
    data: { service: serviceName, price_ngn: priceNgn, method },
  });
}

export function trackPaymentSucceeded(priceNgn: number, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'payment_succeeded',
    level: 'info',
    data: { price_ngn: priceNgn, method },
  });
}

export function trackPaymentFailed(reason: string, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'payment_failed',
    level: 'error',
    data: { reason, method },
  });
}

export function trackPurchaseSucceeded(serviceName: string, orderId: string) {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'purchase_succeeded',
    level: 'info',
    data: { service: serviceName, order_id: orderId },
  });
}

export function trackPurchaseFailed(serviceName: string, reason: string) {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'purchase_failed',
    level: 'error',
    data: { service: serviceName, reason },
  });
}

export function trackCheckoutCompleted(serviceName: string, priceNgn: number) {
  Sentry.addBreadcrumb({
    category: 'checkout',
    message: 'checkout_completed',
    level: 'info',
    data: { service: serviceName, price_ngn: priceNgn },
  });
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

export function trackWalletTopupInitiated(amountNgn: number, method: 'saved_card' | 'paystack') {
  Sentry.addBreadcrumb({
    category: 'wallet',
    message: 'topup_initiated',
    level: 'info',
    data: { amount_ngn: amountNgn, method },
  });
}

export function trackWalletTopupCompleted(amountNgn: number) {
  Sentry.addBreadcrumb({
    category: 'wallet',
    message: 'topup_completed',
    level: 'info',
    data: { amount_ngn: amountNgn },
  });
}

export function trackWalletTopupFailed(reason: string) {
  Sentry.addBreadcrumb({
    category: 'wallet',
    message: 'topup_failed',
    level: 'error',
    data: { reason },
  });
}

// ─── Refunds ──────────────────────────────────────────────────────────────────

export function trackRefundInitiated(orderId: string) {
  Sentry.addBreadcrumb({ category: 'refund', message: 'refund_initiated', level: 'info', data: { order_id: orderId } });
}

export function trackRefundCompleted(orderId: string, amountNgn: number) {
  Sentry.addBreadcrumb({
    category: 'refund',
    message: 'refund_completed',
    level: 'info',
    data: { order_id: orderId, amount_ngn: amountNgn },
  });
}

export function trackRefundFailed(orderId: string, reason?: string) {
  Sentry.addBreadcrumb({
    category: 'refund',
    message: 'refund_failed',
    level: 'error',
    data: { order_id: orderId, reason },
  });
}

// ─── Order / OTP status ───────────────────────────────────────────────────────

export function trackOrderStatusChange(orderId: string, newStatus: string) {
  Sentry.addBreadcrumb({
    category: 'order',
    message: 'order_status_change',
    level: 'info',
    data: { order_id: orderId, status: newStatus },
  });
}

export function trackOtpReceived(orderId: string) {
  // orderId only — never the actual OTP value
  Sentry.addBreadcrumb({ category: 'order', message: 'otp_received', level: 'info', data: { order_id: orderId } });
}

export function trackOtpTimeout(orderId: string) {
  Sentry.addBreadcrumb({ category: 'order', message: 'otp_timeout', level: 'warning', data: { order_id: orderId } });
}

// ─── Support ──────────────────────────────────────────────────────────────────

export function trackSupportInteraction(source: string) {
  Sentry.addBreadcrumb({ category: 'support', message: 'support_opened', level: 'info', data: { source } });
}

// ─── Error capturing ──────────────────────────────────────────────────────────

/**
 * Capture a caught exception with optional non-sensitive context.
 * Never pass passwords, OTPs, card data, or Paystack auth codes as context.
 */
export function captureError(error: unknown, context?: Record<string, unknown>) {
  Sentry.withScope((scope) => {
    if (context) scope.setExtras(context);
    Sentry.captureException(error);
  });
}

export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info') {
  Sentry.captureMessage(message, level);
}
