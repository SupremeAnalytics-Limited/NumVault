import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  StatusBar, Modal, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform, AppState,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Haptics from 'expo-haptics';
import { useAuth, useAlert } from '@/template';
import { useWallet } from '@/hooks/useWallet';
import { useOrders } from '@/hooks/useOrders';
import { initializePayment, chargeWithSavedCard } from '@/services/paystackService';
import { requestNotificationPermissions, sendLowBalanceNotification } from '@/services/notificationService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import {
  trackWalletTopupInitiated, trackWalletTopupCompleted, trackWalletTopupFailed, captureError,
} from '@/services/sentryService';

export default function WalletScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { profile, walletBalance, hasCard, refreshProfile } = useWallet();
  const { transactions, refreshTransactions } = useOrders();
  const { showAlert } = useAlert();

  const [topupModal, setTopupModal] = useState(false);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [webViewUrl, setWebViewUrl] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const LOW_BALANCE_THRESHOLD = 500;
  const lowBalanceNotifiedRef = React.useRef(false);

  useEffect(() => {
    if (user) {
      requestNotificationPermissions();
      refreshProfile();
      refreshTransactions();
    }
  }, [user]);

  // Auto-refresh: poll every 30 s + re-fetch when app comes to foreground
  useEffect(() => {
    if (!user) return;
    pollIntervalRef.current = setInterval(() => {
      refreshProfile();
      refreshTransactions();
    }, 30_000);
    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        refreshProfile();
        refreshTransactions();
      }
      appStateRef.current = next;
    });
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      sub.remove();
    };
  }, [user]);


  // Watch for low balance and fire notification once per session
  useEffect(() => {
    if (
      walletBalance > 0 &&
      walletBalance < LOW_BALANCE_THRESHOLD &&
      !lowBalanceNotifiedRef.current
    ) {
      lowBalanceNotifiedRef.current = true;
      sendLowBalanceNotification(walletBalance);
    }
    if (walletBalance >= LOW_BALANCE_THRESHOLD) {
      lowBalanceNotifiedRef.current = false;
    }
  }, [walletBalance]);

  const handleTopup = async () => {
    const amt = parseFloat(amount);
    if (!amt || amt < 100) {
      showAlert('Minimum top-up is ₦100');
      return;
    }
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setLoading(true);

    try {
      // Use saved card if available
      if (hasCard && profile?.card_auth_code) {
        trackWalletTopupInitiated(amt, 'saved_card');
        const result = await chargeWithSavedCard(
          user?.email || '',
          amt,
          profile.card_auth_code,
          'wallet_topup'
        );

        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        trackWalletTopupCompleted(amt);
        setTopupModal(false);
        setAmount('');
        showAlert('Success', `₦${amt.toLocaleString()} added to your wallet`);
        await refreshProfile();
        await refreshTransactions();
      } else {
        // Open Paystack WebView — must close topupModal FIRST to avoid stacked modal bug
        trackWalletTopupInitiated(amt, 'paystack');
        const result = await initializePayment(user?.email || '', amt, 'wallet_topup');
        const authUrl = result?.data?.authorization_url;
        if (!authUrl) throw new Error('No payment URL received. Please try again.');
        setTopupModal(false);
        // Small delay to let the first modal fully dismiss before opening WebView
        setTimeout(() => setWebViewUrl(authUrl), 400);
      }
    } catch (e: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      trackWalletTopupFailed(e.message || 'Unknown error');
      captureError(e, { stage: 'wallet_topup' });
      showAlert('Top-up Failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleWebViewNav = async (url: string) => {
    if (
      url.includes('numvault.app/payment/callback') ||
      url.includes('paystack.com/close') ||
      url.includes('standard.paystack.co/close')
    ) {
      setWebViewUrl(null);
      setAmount('');
      // Refresh after short delay to allow webhook processing
      setTimeout(async () => {
        await refreshProfile();
        await refreshTransactions();
      }, 2500);
      showAlert('Payment Processed', 'Your wallet will be updated shortly.');
    }
  };

  const formatDate = (d: string) => new Date(d).toLocaleDateString('en-NG', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  const QUICK_AMOUNTS = [500, 1000, 2000, 5000, 10000];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Wallet</Text>
        <TouchableOpacity
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            refreshProfile();
            refreshTransactions();
          }}
          style={styles.refreshBtn}
        >
          <MaterialIcons name="refresh" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {/* Balance Card */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceGlow} />
          <Text style={styles.balanceLabel}>Available Balance</Text>
          <Text style={styles.balanceAmount}>₦{Number(walletBalance).toLocaleString()}</Text>

          {hasCard && (
            <View style={styles.cardIndicator}>
              <MaterialIcons name="credit-card" size={14} color={Colors.primary} />
              <Text style={styles.cardIndicatorText}>
                {profile?.card_brand?.toUpperCase()} •••• {profile?.card_last4}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={styles.topupBtn}
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setTopupModal(true);
            }}
            activeOpacity={0.85}
          >
            <MaterialIcons name="add" size={18} color={Colors.black} />
            <Text style={styles.topupBtnText}>Add Money</Text>
          </TouchableOpacity>
        </View>

        {/* Transactions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Transaction History</Text>

          {transactions.length === 0 ? (
            <View style={styles.emptyTx}>
              <MaterialIcons name="receipt" size={40} color={Colors.textMuted} />
              <Text style={styles.emptyTxText}>No transactions yet</Text>
            </View>
          ) : (
            transactions.map((tx) => (
              <View key={tx.id} style={styles.txRow}>
                <View style={[styles.txIcon, { backgroundColor: tx.type === 'credit' ? Colors.successMuted : Colors.errorMuted }]}>
                  <MaterialIcons
                    name={tx.type === 'credit' ? 'arrow-downward' : 'arrow-upward'}
                    size={16}
                    color={tx.type === 'credit' ? Colors.success : Colors.error}
                  />
                </View>
                <View style={styles.txInfo}>
                  <Text style={styles.txDesc}>{tx.description || (tx.type === 'credit' ? 'Wallet credit' : 'Wallet debit')}</Text>
                  <Text style={styles.txDate}>{formatDate(tx.created_at)}</Text>
                </View>
                <Text style={[styles.txAmount, { color: tx.type === 'credit' ? Colors.success : Colors.error }]}>
                  {tx.type === 'credit' ? '+' : '-'}₦{Number(tx.amount).toLocaleString()}
                </Text>
              </View>
            ))
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Top-up Modal */}
      <Modal visible={topupModal} transparent animationType="slide" onRequestClose={() => setTopupModal(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalOverlay}>
            <View style={styles.modalCard}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>Add Money</Text>
              <Text style={styles.modalSub}>
                {hasCard
                  ? `Charging saved card •••• ${profile?.card_last4}`
                  : "You'll be directed to Paystack checkout. Paystack transaction charges apply."}
              </Text>

              {/* Quick amounts */}
              <View style={styles.quickAmounts}>
                {QUICK_AMOUNTS.map((a) => (
                  <TouchableOpacity
                    key={a}
                    style={[styles.quickBtn, amount === String(a) && styles.quickBtnActive]}
                    onPress={async () => {
                      await Haptics.selectionAsync();
                      setAmount(String(a));
                    }}
                  >
                    <Text style={[styles.quickBtnText, amount === String(a) && styles.quickBtnTextActive]}>
                      ₦{a.toLocaleString()}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.amountInput}>
                <Text style={styles.currencyLabel}>₦</Text>
                <TextInput
                  style={styles.amountInputField}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="Enter amount"
                  placeholderTextColor={Colors.textMuted}
                  keyboardType="numeric"
                />
              </View>

              <TouchableOpacity
                style={[styles.topupConfirm, loading && styles.topupConfirmDisabled]}
                onPress={handleTopup}
                disabled={loading}
                activeOpacity={0.85}
              >
                {loading ? (
                  <ActivityIndicator color={Colors.black} />
                ) : (
                  <>
                    <MaterialIcons name="lock" size={16} color={Colors.black} />
                    <Text style={styles.topupConfirmText}>
                      {hasCard ? "Charge Saved Card" : "Continue to Payment"}
                    </Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity onPress={() => setTopupModal(false)} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Paystack WebView */}
      <Modal visible={!!webViewUrl} animationType="slide" onRequestClose={() => setWebViewUrl(null)}>
        <View style={[styles.webViewContainer, { paddingTop: insets.top }]}>
          <View style={styles.webViewHeader}>
            <TouchableOpacity onPress={() => setWebViewUrl(null)}>
              <MaterialIcons name="close" size={24} color={Colors.text} />
            </TouchableOpacity>
            <Text style={styles.webViewTitle}>Secure Payment</Text>
            <View style={{ width: 24 }} />
          </View>
          {webViewUrl && (
            <WebView
              source={{ uri: webViewUrl }}
              onNavigationStateChange={(state) => handleWebViewNav(state.url)}
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
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  refreshBtn: { padding: 8, borderRadius: Radius.md, backgroundColor: Colors.surface },
  balanceCard: {
    margin: Spacing.lg,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.primary,
    overflow: 'hidden',
    gap: Spacing.sm,
  },
  balanceGlow: {
    position: 'absolute',
    top: -40,
    right: -40,
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.primaryMuted,
  },
  balanceLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },
  balanceAmount: {
    color: Colors.text,
    fontSize: FontSize.display,
    fontWeight: FontWeight.bold,
  },
  cardIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.primaryMuted,
    alignSelf: 'flex-start',
    borderRadius: Radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cardIndicatorText: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.medium },
  topupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    justifyContent: 'center',
    marginTop: Spacing.sm,
  },
  topupBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.md },
  section: { paddingHorizontal: Spacing.lg },
  sectionTitle: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
    marginBottom: Spacing.md,
  },
  emptyTx: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.md },
  emptyTxText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  txRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  txIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  txInfo: { flex: 1 },
  txDesc: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium },
  txDate: { color: Colors.textSecondary, fontSize: FontSize.xs },
  txAmount: { fontSize: FontSize.md, fontWeight: FontWeight.bold },
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    padding: Spacing.xl,
    paddingBottom: 48,
    gap: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder, alignSelf: 'center' },
  modalTitle: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold, textAlign: 'center' },
  modalSub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center' },
  quickAmounts: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  quickBtn: {
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.full,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Colors.surfaceElevated,
  },
  quickBtnActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  quickBtnText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  quickBtnTextActive: { color: Colors.primary, fontWeight: FontWeight.semibold },
  amountInput: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 52,
  },
  currencyLabel: { color: Colors.primary, fontSize: FontSize.lg, fontWeight: FontWeight.bold, marginRight: 4 },
  amountInputField: { flex: 1, color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  topupConfirm: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    height: 52,
    justifyContent: 'center',
  },
  topupConfirmDisabled: { opacity: 0.5 },
  topupConfirmText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.md },
  cancelBtn: { alignItems: 'center', paddingVertical: Spacing.sm },
  cancelText: { color: Colors.textSecondary, fontSize: FontSize.sm },
  webViewContainer: { flex: 1, backgroundColor: Colors.background },
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
