/**
 * NumVault — Sentry observability service
 *
 * Provides structured event tracking, error capturing, and user context
 * management for all key NumVault user journeys.
 *
 * Privacy rules enforced here:
 *  - No passwords, OTPs, card numbers, CVV, or Paystack auth codes
 *  - No full phone numbers (purchased temporary numbers are NEVER sent)
 *  - No wallet credentials or API keys
 *  - User is identified by internal ID only (no email sent unless opted in)
 *
 * Note: Sentry.metrics (Custom Metrics API) was deprecated and removed by
 * Sentry in October 2024 (affected SDK ≥6). Counters/distributions are
 * replaced with structured breadcrumbs + captureMessage events that appear
 * in Issues and are searchable in Sentry.
 */

import * as Sentry from '@sentry/react-native';

// ─── User context ─────────────────────────────────────────────────────────────

/** Set safe user context after login. Only the internal ID is sent. */
export function setSentryUser(userId: string) {
  Sentry.setUser({ id: userId });
}

/** Clear user context on logout or account deletion. */
export function clearSentryUser() {
  Sentry.setUser(null);
}

// ─── Auth events ──────────────────────────────────────────────────────────────

export function trackSignupStarted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_started', level: 'info' });
}

export function trackSignupOtpSent(success: boolean, errorMessage?: string) {
  if (success) {
    Sentry.addBreadcrumb({ category: 'auth', message: 'signup_otp_sent', level: 'info' });
  } else {
    Sentry.addBreadcrumb({ category: 'auth', message: 'signup_otp_send_failed', level: 'warning',
      data: { error: errorMessage } });
  }
}

export function trackSignupCompleted(userId: string) {
  setSentryUser(userId);
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_completed', level: 'info' });
  Sentry.captureMessage('auth.signup.success', 'info');
}

export function trackSignupFailed(reason: string) {
  Sentry.addBreadcrumb({ category: 'auth', message: 'signup_failed', level: 'warning',
    data: { reason } });
}

export function trackLoginStarted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_started', level: 'info' });
}

export function trackLoginCompleted(userId: string) {
  setSentryUser(userId);
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_completed', level: 'info' });
}

export function trackLoginFailed(reason: string) {
  Sentry.addBreadcrumb({ category: 'auth', message: 'login_failed', level: 'warning',
    data: { reason } });
}

export function trackOnboardingCompleted() {
  Sentry.addBreadcrumb({ category: 'onboarding', message: 'onboarding_completed', level: 'info' });
}

export function trackLogout() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'logout', level: 'info' });
  clearSentryUser();
}

export function trackAccountDeleted() {
  Sentry.addBreadcrumb({ category: 'auth', message: 'account_deleted', level: 'info' });
  clearSentryUser();
}

// ─── Number search / service browse events ────────────────────────────────────

export function trackSearchStarted(query: string) {
  // Only track that a search happened, not the actual query content
  Sentry.addBreadcrumb({ category: 'search', message: 'number_search_started', level: 'info',
    data: { query_length: query.length } });
}

export function trackServiceSelected(serviceName: string, provider: string) {
  Sentry.addBreadcrumb({ category: 'purchase', message: 'number_selected', level: 'info',
    data: { service: serviceName, provider } });
}

// ─── Checkout / purchase events ───────────────────────────────────────────────

export function trackCheckoutOpened(serviceName: string, priceNgn: number, fromWallet: boolean) {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'checkout_opened', level: 'info',
    data: { service: serviceName, price_ngn: priceNgn, payment_method: fromWallet ? 'wallet' : 'paystack' } });
}

export function trackPurchaseInitiated(serviceName: string, priceNgn: number, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'purchase_initiated', level: 'info',
    data: { service: serviceName, price_ngn: priceNgn, method } });
}

export function trackPaymentSucceeded(priceNgn: number, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'payment_succeeded', level: 'info',
    data: { price_ngn: priceNgn, method } });
}

export function trackPaymentFailed(reason: string, method: 'wallet' | 'paystack') {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'payment_failed', level: 'warning',
    data: { reason, method } });
}

export function trackPurchaseSucceeded(serviceName: string, orderId: string) {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'purchase_succeeded', level: 'info',
    data: { service: serviceName, order_id: orderId } });
}

export function trackPurchaseFailed(serviceName: string, reason: string) {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'purchase_failed', level: 'warning',
    data: { service: serviceName, reason } });
}

export function trackCheckoutCompleted(serviceName: string, priceNgn: number) {
  Sentry.addBreadcrumb({ category: 'checkout', message: 'checkout_completed', level: 'info',
    data: { service: serviceName, price_ngn: priceNgn } });
}

// ─── Wallet events ────────────────────────────────────────────────────────────

export function trackWalletTopupInitiated(amountNgn: number, method: 'saved_card' | 'paystack') {
  Sentry.addBreadcrumb({ category: 'wallet', message: 'topup_initiated', level: 'info',
    data: { amount_ngn: amountNgn, method } });
}

export function trackWalletTopupCompleted(amountNgn: number) {
  Sentry.addBreadcrumb({ category: 'wallet', message: 'topup_completed', level: 'info',
    data: { amount_ngn: amountNgn } });
}

export function trackWalletTopupFailed(reason: string) {
  Sentry.addBreadcrumb({ category: 'wallet', message: 'topup_failed', level: 'warning',
    data: { reason } });
}

// ─── Refund events ────────────────────────────────────────────────────────────

export function trackRefundInitiated(orderId: string) {
  Sentry.addBreadcrumb({ category: 'refund', message: 'refund_initiated', level: 'info',
    data: { order_id: orderId } });
}

export function trackRefundCompleted(orderId: string, amountNgn: number) {
  Sentry.addBreadcrumb({ category: 'refund', message: 'refund_completed', level: 'info',
    data: { order_id: orderId, amount_ngn: amountNgn } });
}

export function trackRefundFailed(orderId: string, reason?: string) {
  Sentry.addBreadcrumb({ category: 'refund', message: 'refund_failed', level: 'error',
    data: { order_id: orderId, reason } });
}

// ─── Order status events ──────────────────────────────────────────────────────

export function trackOrderStatusChange(orderId: string, newStatus: string) {
  Sentry.addBreadcrumb({ category: 'order', message: 'order_status_change', level: 'info',
    data: { order_id: orderId, status: newStatus } });
}

export function trackOtpReceived(orderId: string) {
  Sentry.addBreadcrumb({ category: 'order', message: 'otp_received', level: 'info',
    data: { order_id: orderId } });
}

export function trackOtpTimeout(orderId: string) {
  Sentry.addBreadcrumb({ category: 'order', message: 'otp_timeout', level: 'warning',
    data: { order_id: orderId } });
}

// ─── Support interaction ──────────────────────────────────────────────────────

export function trackSupportInteraction(source: string) {
  Sentry.addBreadcrumb({ category: 'support', message: 'support_opened', level: 'info',
    data: { source } });
}

// ─── Error capturing ──────────────────────────────────────────────────────────

/** Capture a meaningful, non-sensitive error with optional context. */
export function captureError(error: unknown, context?: Record<string, unknown>) {
  if (context) {
    Sentry.withScope((scope) => {
      scope.setExtras(context);
      Sentry.captureException(error);
    });
  } else {
    Sentry.captureException(error);
  }
}

/** Capture a named message event (non-exception). */
export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info') {
  Sentry.captureMessage(message, level);
}
