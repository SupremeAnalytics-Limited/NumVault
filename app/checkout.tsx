import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  StatusBar, ActivityIndicator, Modal,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import { useAuth, useAlert } from '@/template';
import { useOrders } from '@/hooks/useOrders';
import { useWallet } from '@/hooks/useWallet';
import { initializePayment, purchaseNumber } from '@/services/paystackService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import {
  trackCheckoutOpened, trackPurchaseInitiated, trackPaymentSucceeded,
  trackPaymentFailed, trackPurchaseSucceeded, trackPurchaseFailed,
  trackCheckoutCompleted, captureError,
} from '@/services/sentryService';
import { PLATFORM_ICONS } from '@/constants/config';

export default function CheckoutScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const { refreshOrders } = useOrders();
  const { walletBalance, refreshProfile } = useWallet();
  const { showAlert } = useAlert();

  const params = useLocalSearchParams<{
    provider_code: string;
    country_code: string;  // string for Server B (e.g. "tiktok")
    country_name: string;
    project_code: string;
    project_name: string;
    price: string;
    wholesale_price: string; // Socially.ng raw wholesale cost — used for exact Paystack split
  }>();

  const [balanceReady, setBalanceReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [webViewUrl, setWebViewUrl] = useState<string | null>(null);
  const [paystackRef, setPaystackRef] = useState<string | null>(null);
  const [purchaseError, setPurchaseError] = useState<{ message: string; hint?: string } | null>(null);
  const [purchaseStage, setPurchaseStage] = useState<'idle' | 'paying' | 'purchasing'>('idle');
  // Guard: prevent handleWebViewNav from firing executePurchase more than once per payment attempt
  const callbackFiredRef = React.useRef(false);

  // Refresh wallet balance on mount so the checkout always shows the live balance.
  useEffect(() => {
    refreshProfile().finally(() => setBalanceReady(true));
  }, []);

  const basePrice = parseFloat(params.price || '0');
  // Wholesale cost from Socially.ng — the exact amount Socially.ng must receive.
  // Falls back to price/MARKUP (1.4×) if not supplied (defensive).
  const wholesalePrice = params.wholesale_price
    ? parseFloat(params.wholesale_price)
    : basePrice / 1.4;
  const price = basePrice;

  const parsePurchaseError = (rawMessage: string): { message: string; hint?: string } => {
    const msg = rawMessage.replace(/^Socially:\s*/i, '').trim();
    const lower = msg.toLowerCase();
    // NV-901: generic provider failure — already formatted by server, pass through cleanly
    if (lower.includes('nv-901'))
      return { message: 'Transaction could not be completed. Your payment has been refunded \u2014 please try again in a moment.', hint: 'Reference: NV-901' };
    if (lower.includes('price') && lower.includes('changed'))
      return { message: msg, hint: 'Prices update in real time. Go back to see the current price.' };
    if (lower.includes('insufficient') || lower.includes('balance') || lower.includes('fund'))
      return { message: msg, hint: 'Provider balance is low. Try again in a few minutes.' };
    if (lower.includes('unavailable') || lower.includes('no number') || lower.includes('stock'))
      return { message: msg, hint: 'No numbers available for this country right now.' };
    if (lower.includes('not found') || lower.includes('route') || lower.includes('404'))
      return { message: msg, hint: 'Try a different country or platform.' };
    if (lower.includes('unauthorized') || lower.includes('invalid token'))
      return { message: msg, hint: 'Authentication issue. Contact support.' };
    if (lower.includes('payment') || lower.includes('verify'))
      return { message: msg, hint: 'Payment could not be verified. Contact support with your reference.' };
    return { message: msg };
  };

  const isWhatsApp = (params.project_name || '').toLowerCase().includes('whatsapp');

  // Format naira: show 2 decimal places only when there are kobo cents
  const formatNaira = (amount: number): string => {
    const kobo = Math.round(amount * 100) % 100;
    if (kobo !== 0) {
      return amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return Math.round(amount).toLocaleString();
  };

  const executePurchase = async (reference: string | null, fromWallet: boolean) => {
    setPurchaseError(null);
    setPurchaseStage('purchasing');
    setLoading(true);
    trackPurchaseInitiated(params.project_name, price, fromWallet ? 'wallet' : 'paystack');
    try {
      const data = await purchaseNumber({
        provider_code: params.provider_code,
        country_code: params.country_code,
        project_code: params.project_code,
        project_name: params.project_name,
        country_name: params.country_name,
        amount_paid: price,
        ...(fromWallet
          ? { use_wallet: true }
          : { paystack_reference: reference! }
        ),
      });

      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refreshOrders();
      await refreshProfile();

      const orderId = data?.data?.order?.id;
      trackPaymentSucceeded(price, fromWallet ? 'wallet' : 'paystack');
      trackPurchaseSucceeded(params.project_name, orderId || 'unknown');
      trackCheckoutCompleted(params.project_name, price);
      if (orderId) {
        router.replace({ pathname: '/number-display', params: { order_id: orderId } });
      }
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const parsed = parsePurchaseError(e.message || 'Purchase failed. Please try again.');
      trackPurchaseFailed(params.project_name, parsed.message);
      captureError(e, { service: params.project_name, method: fromWallet ? 'wallet' : 'paystack', stage: 'purchase' });
      // If the server refunded the charge, surface that clearly
      if (e.refunded) {
        const amt = e.refund_amount ?? price;
        parsed.hint = fromWallet
          ? `\u20a6${Number(amt).toLocaleString()} has been returned to your wallet balance.`
          : `Your payment of \u20a6${Number(amt).toLocaleString()} has been refunded to your wallet.`;
      }
      setPurchaseError(parsed);
    } finally {
      setLoading(false);
      setPurchaseStage('idle');
    }
  };

  const handlePay = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPurchaseError(null);

    // ── Wallet-first: skip Paystack entirely if balance covers the price ──
    if (canPayFromWallet) {
      trackCheckoutOpened(params.project_name, price, true);
      setPurchaseStage('purchasing');
      setLoading(true);
      await executePurchase(null, true);
      setLoading(false);
      setPurchaseStage('idle');
      return;
    }

    // ── Paystack charge ──
    setPurchaseStage('paying');
    setLoading(true);
    // Reset single-fire guard for this new payment attempt
    callbackFiredRef.current = false;
    try {
      // Pass purchase metadata so the webhook safety net can complete the purchase
      // server-side if the WebView never catches the callback (bank transfer, USSD, etc.).
      // wholesale_cost is passed so wallet-topup can apply an exact transaction_charge
      // (flat kobo amount = retail − wholesale) instead of relying on percentage_charge,
      // which can drift due to Math.ceil() rounding on the retail price.
      trackCheckoutOpened(params.project_name, price, false);
      const data = await initializePayment(user?.email || '', price, 'number_purchase', {
        provider_code: params.provider_code,
        country_code: params.country_code,
        project_code: params.project_code,
        project_name: params.project_name,
        country_name: params.country_name,
        wholesale_cost: wholesalePrice,
      });
      if (data?.data?.authorization_url) {
        setPaystackRef(data.data.reference);
        setWebViewUrl(data.data.authorization_url);
      }
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackPaymentFailed(e.message || 'Payment initialization failed', 'paystack');
      captureError(e, { stage: 'payment_init', service: params.project_name });
      setPurchaseError({ message: e.message || 'Payment initialization failed. Please try again.' });
    } finally {
      setLoading(false);
      setPurchaseStage('idle');
    }
  };

  const handleWebViewNav = async (url: string) => {
    if (url.includes('numvault.app/payment/callback') || url.includes('paystack.com/close')) {
      // Single-fire guard: only process this callback once per payment attempt
      if (callbackFiredRef.current) {
        console.log('checkout: WebView callback already handled, ignoring duplicate');
        return;
      }
      callbackFiredRef.current = true;
      setWebViewUrl(null);
      if (paystackRef) {
        setTimeout(() => executePurchase(paystackRef, false), 1500);
      } else {
        setPurchaseError({ message: 'Payment reference lost. Contact support.' });
      }
    }
  };

  const canPayFromWallet = balanceReady && walletBalance >= price;

  const payBtnLabel = canPayFromWallet
    ? `Pay \u20a6${price.toLocaleString()} from Wallet`
    : `Pay \u20a6${price.toLocaleString()}`;

  const stageLabel = purchaseStage === 'paying'
    ? 'Opening payment...'
    : purchaseStage === 'purchasing'
    ? (canPayFromWallet ? 'Paying from wallet...' : 'Securing your number...')
    : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            router.back();
          }}
          style={styles.backBtn}
        >
          <MaterialIcons name="arrow-back" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Order Summary</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 120 }]}
      >
        {/* ── Wallet balance banner (if sufficient) ── */}
        {canPayFromWallet && (
          <View style={styles.walletBanner}>
            <MaterialIcons name="account-balance-wallet" size={16} color={Colors.primary} />
            <Text style={styles.walletBannerText}>
              Wallet balance: <Text style={styles.walletBannerAmount}>₦{walletBalance.toLocaleString()}</Text> — this purchase will be deducted instantly.
            </Text>
          </View>
        )}

        {/* ── Order card ── */}
        <View style={styles.orderCard}>
          {/* Platform row */}
          <View style={styles.platformRow}>
            <View style={styles.platformIcon}>
              <MaterialIcons
                name={(PLATFORM_ICONS[params.project_name] || 'phone-android') as any}
                size={28}
                color={Colors.primary}
              />
            </View>
            <View style={styles.platformInfo}>
              <Text style={styles.platformName}>{params.project_name}</Text>
              <Text style={styles.platformSub}>{params.country_name} · SMS Verification</Text>
            </View>
            <View style={styles.providerTag}>
              <Text style={styles.providerTagText}>NumVault Cloud</Text>
            </View>
          </View>

          <View style={styles.divider} />

          {/* WhatsApp OTP delivery notice */}
          {isWhatsApp && (
            <View style={styles.deliveryNotice}>
              <MaterialIcons name="info-outline" size={14} color={Colors.warning} />
              <Text style={styles.deliveryNoticeText}>
                OTP delivery for WhatsApp numbers currently has a ~25% success rate. If your code does not arrive, your payment will be automatically refunded.
              </Text>
            </View>
          )}

          {/* Price breakdown */}
          <View style={styles.priceSection}>
            <View style={styles.priceRow}>
              <Text style={styles.priceRowLabel}>Service fee</Text>
              <Text style={styles.priceRowValue}>₦{price.toLocaleString()}</Text>
            </View>
            {balanceReady && !canPayFromWallet ? (
              <>
                <View style={styles.priceRow}>
                  <Text style={styles.priceRowLabel}>Wallet balance</Text>
                  <Text style={styles.priceRowValue}>₦{formatNaira(walletBalance)}</Text>
                </View>
                <View style={styles.priceRow}>
                  <Text style={styles.priceRowLabel}>Short by</Text>
                  <Text style={[styles.priceRowValue, { color: Colors.warning }]}>₦{formatNaira(Math.max(0, price - walletBalance))}</Text>
                </View>
              </>
            ) : null}
            <View style={[styles.priceRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>₦{price.toLocaleString()}</Text>
            </View>
          </View>
        </View>

        {/* ── Payment methods (shown while balance loads or when wallet is insufficient) ── */}
        {(!balanceReady || !canPayFromWallet) && (
        <View style={styles.methodsCard}>
          <Text style={styles.methodsTitle}>Pay with</Text>
          <View style={styles.methodsList}>
            {[
              { icon: 'credit-card', label: 'Debit / Credit Card' },
              { icon: 'account-balance', label: 'Bank Transfer' },
              { icon: 'smartphone', label: 'USSD' },
            ].map((m) => (
              <View key={m.label} style={styles.methodRow}>
                <View style={styles.methodIconWrap}>
                  <MaterialIcons name={m.icon as any} size={18} color={Colors.primary} />
                </View>
                <Text style={styles.methodLabel}>{m.label}</Text>
                <MaterialIcons name="check-circle" size={16} color={Colors.primary} style={{ opacity: 0.6 }} />
              </View>
            ))}
          </View>
          <View style={styles.secureRow}>
            <MaterialIcons name="lock" size={12} color={Colors.textMuted} />
            <Text style={styles.secureText}>Secured by Paystack · 256-bit TLS encryption</Text>
          </View>
          <View style={styles.chargesNoteRow}>
            <MaterialIcons name="info" size={13} color={Colors.primary} />
            <Text style={styles.chargesNote}>Paystack transaction charges apply.</Text>
          </View>
        </View>
        )}

        {/* ── Error banner ── */}
        {purchaseError && (
          <View style={styles.errorBanner}>
            <View style={styles.errorBannerTop}>
              <MaterialIcons name="error-outline" size={18} color={Colors.error} />
              <Text style={styles.errorBannerTitle}>Purchase Failed</Text>
              <TouchableOpacity
                onPress={() => setPurchaseError(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <MaterialIcons name="close" size={16} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.errorBannerMsg}>{purchaseError.message}</Text>
            {purchaseError.hint && (
              <Text style={styles.errorBannerHint}>💡 {purchaseError.hint}</Text>
            )}
            <View style={styles.errorActions}>
              <TouchableOpacity
                style={styles.errorActionBack}
                onPress={() => { setPurchaseError(null); router.back(); }}
                activeOpacity={0.8}
              >
                <Text style={styles.errorActionBackText}>Change selection</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.errorActionRetry}
                onPress={() => { setPurchaseError(null); handlePay(); }}
                disabled={loading}
                activeOpacity={0.8}
              >
                <MaterialIcons name="refresh" size={14} color={Colors.black} />
                <Text style={styles.errorActionRetryText}>Try again</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </ScrollView>

      {/* ── Sticky Pay CTA ── */}
      <View style={[styles.ctaBar, { paddingBottom: insets.bottom + 16 }]}>
        <TouchableOpacity
          style={[styles.payBtn, loading && styles.payBtnDisabled]}
          onPress={handlePay}
          disabled={loading}
          activeOpacity={0.88}
        >
          {loading ? (
            <View style={styles.payBtnLoading}>
              <ActivityIndicator color={Colors.black} />
              {stageLabel && <Text style={styles.payBtnLoadingText}>{stageLabel}</Text>}
            </View>
          ) : (
            <>
              <MaterialIcons name={canPayFromWallet ? 'account-balance-wallet' : 'payment'} size={20} color={Colors.black} />
              <Text style={styles.payBtnText}>{payBtnLabel}</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* ── Paystack WebView ── */}
      <Modal visible={!!webViewUrl} animationType="slide" onRequestClose={() => setWebViewUrl(null)}>
        <View style={[styles.webViewWrap, { paddingTop: insets.top }]}>
          <View style={styles.webViewHeader}>
            <TouchableOpacity onPress={() => setWebViewUrl(null)} style={styles.backBtn}>
              <MaterialIcons name="close" size={20} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.webViewTitle}>Secure Payment</Text>
            <View style={{ width: 36 }} />
          </View>
          {webViewUrl && (
            <WebView
              source={{ uri: webViewUrl }}
              onNavigationStateChange={(s) => handleWebViewNav(s.url)}
              startInLoadingState
              renderLoading={() => <ActivityIndicator color={Colors.primary} style={{ flex: 1 }} />}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  content: { padding: Spacing.lg, gap: Spacing.lg },

  // Order card
  orderCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  platformRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  platformIcon: {
    width: 52, height: 52, borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.primary,
  },
  platformInfo: { flex: 1 },
  platformName: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  platformSub: { color: Colors.textSecondary, fontSize: FontSize.sm, marginTop: 2 },
  providerTag: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  providerTagText: { color: Colors.textMuted, fontSize: 10, fontWeight: FontWeight.semibold },
  divider: { height: 1, backgroundColor: Colors.surfaceBorder, marginHorizontal: Spacing.lg },

  priceSection: { padding: Spacing.lg, gap: Spacing.sm },
  priceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  priceRowLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },
  priceRowValue: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  totalRow: { marginTop: Spacing.sm, paddingTop: Spacing.sm, borderTopWidth: 1, borderTopColor: Colors.surfaceBorder },
  totalLabel: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  totalValue: { color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.bold },

  // Payment methods
  methodsCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  methodsTitle: { color: Colors.textSecondary, fontSize: FontSize.xs, fontWeight: FontWeight.semibold, letterSpacing: 0.5 },
  methodsList: { gap: Spacing.sm },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  methodIconWrap: {
    width: 36, height: 36, borderRadius: Radius.sm,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  methodLabel: { flex: 1, color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  secureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: Spacing.sm,
    paddingTop: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  secureText: { color: Colors.textMuted, fontSize: 11 },
  chargesNoteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: 'rgba(0,200,83,0.3)',
    borderRadius: Radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginTop: 2,
  },
  chargesNote: { color: Colors.primary, fontSize: 12, fontWeight: FontWeight.semibold },

  // WhatsApp delivery notice
  deliveryNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: 'rgba(255,171,0,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,171,0,0.35)',
    borderRadius: Radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginHorizontal: Spacing.lg,
    marginBottom: 2,
  },
  deliveryNoticeText: {
    flex: 1,
    color: Colors.warning,
    fontSize: 11,
    lineHeight: 16,
  },

  // Wallet banner
  walletBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.lg,
    padding: Spacing.md,
  },
  walletBannerText: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.xs, lineHeight: 18 },
  walletBannerAmount: { color: Colors.primary, fontWeight: FontWeight.bold },

  // Error banner
  errorBanner: {
    backgroundColor: Colors.errorMuted,
    borderWidth: 1,
    borderColor: Colors.error,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.md,
  },
  errorBannerTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  errorBannerTitle: { flex: 1, color: Colors.error, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  errorBannerMsg: {
    color: Colors.text, fontSize: FontSize.sm, lineHeight: 20,
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.sm, padding: Spacing.md,
    borderLeftWidth: 3, borderLeftColor: Colors.error,
    fontFamily: 'monospace',
  },
  errorBannerHint: { color: Colors.warning, fontSize: FontSize.xs, lineHeight: 18 },
  errorActions: { flexDirection: 'row', gap: Spacing.sm },
  errorActionBack: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, paddingVertical: 10,
  },
  errorActionBackText: { color: Colors.textSecondary, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  errorActionRetry: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, backgroundColor: Colors.error,
    borderRadius: Radius.md, paddingVertical: 10,
  },
  errorActionRetryText: { color: Colors.black, fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  // Pay CTA bar
  ctaBar: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.background,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  payBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    height: 56,
  },
  payBtnDisabled: { opacity: 0.6 },
  payBtnText: { color: Colors.black, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  payBtnLoading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  payBtnLoadingText: { color: Colors.black, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },

  // WebView
  webViewWrap: { flex: 1, backgroundColor: Colors.background },
  webViewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  webViewTitle: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
});
