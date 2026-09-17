import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, StatusBar,
  ScrollView, ActivityIndicator, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAlert, getSupabaseClient } from '@/template';
import { fetchOrder, Order } from '@/services/orderService';
import { requestNotificationPermissions, sendOTPReceivedNotification } from '@/services/notificationService';
import { getOTP } from '@/services/sociallyService';
import { OTP_POLL_INTERVAL, OTP_TIMEOUT } from '@/constants/config';
import {
  trackOtpReceived, trackOtpTimeout, trackRefundInitiated, trackRefundCompleted,
  trackRefundFailed, trackOrderStatusChange, captureError,
} from '@/services/sentryService';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const supabase = getSupabaseClient();

export default function NumberDisplayScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { showAlert } = useAlert();
  const { order_id } = useLocalSearchParams<{ order_id: string }>();

  const [order, setOrder] = useState<Order | null>(null);
  const [timeLeft, setTimeLeft] = useState(OTP_TIMEOUT / 1000);
  const [expired, setExpired] = useState(false);
  const [copiedNumber, setCopiedNumber] = useState(false);
  const [copiedOTP, setCopiedOTP] = useState(false);
  const [copiedRef, setCopiedRef] = useState(false);
  const [requestingOTP, setRequestingOTP] = useState(false);
  const [otpRequested, setOtpRequested] = useState(false);
  const [refundAmount, setRefundAmount] = useState<number | null>(null);
  const [refundError, setRefundError] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // When the context's expiry watcher flips the order to 'expired' while this
  // screen is open, the DB polling below picks up status='expired'. Surface
  // the refund amount from amount_paid so the UI shows the confirmed message.
  useEffect(() => {
    if (order?.status === 'expired' && !refundAmount) {
      setExpired(true);
      setTimeLeft(0);
      setRefundAmount(Number(order.amount_paid));
      clearInterval(pollRef.current!);
      clearInterval(timerRef.current!);
    }
  }, [order?.status]);

  useEffect(() => {
    if (!order_id) return;
    requestNotificationPermissions();
    loadOrderAndMaybeStartTimer();

    return () => {
      clearInterval(pollRef.current!);
      clearInterval(timerRef.current!);
    };
  }, [order_id]);

  const loadOrderAndMaybeStartTimer = async () => {
    const data = await fetchOrder(order_id);
    setInitialLoading(false);
    if (!data) return;
    setOrder(data);

    // ── Guard: only start the countdown + expiry logic for orders that are
    // genuinely still pending with no OTP. If the order is already completed
    // or expired (e.g. reopened from the Orders list), skip the timer entirely
    // to avoid incorrectly re-running expiry logic on a finished order.
    if (data.status !== 'pending' || data.otp) {
      if (data.status === 'expired') {
        setExpired(true);
        setTimeLeft(0);
        // Show the refund-processed message immediately — the refund was already
        // handled either by expire-order (client-triggered) or auto-expire-orders
        // (server-side cron). No need to call expire-order again.
        setRefundAmount(Number(data.amount_paid));
      }
      return; // ← do NOT start timer or polling
    }

    // Fresh pending order — start the countdown + polling.
    // Account for time already elapsed since order creation so the displayed
    // timer matches reality (e.g. if user left and came back).
    const elapsed = Math.floor((Date.now() - new Date(data.created_at).getTime()) / 1000);
    const remaining = Math.max(0, OTP_TIMEOUT / 1000 - elapsed);

    if (remaining === 0) {
      // Already past the window by the time this screen opened — trigger expiry immediately.
      setExpired(true);
      setTimeLeft(0);
      triggerExpiry();
      return;
    }

    setTimeLeft(remaining);
    startTimerFromRemaining(remaining);
  };

  // Extracted expiry call so it can be reused by both the timer and the
  // "already past window" guard in loadOrderAndMaybeStartTimer.
  const triggerExpiry = async () => {
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    trackOtpTimeout(order_id);
    trackRefundInitiated(order_id);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
      const res = await fetch(`${supabaseUrl}/functions/v1/expire-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ order_id }),
      });
      const result = await res.json();
      if (result.refunded && result.refund_amount) {
        setRefundAmount(result.refund_amount);
        trackRefundCompleted(order_id, result.refund_amount);
      } else if (result.already_handled || result.already_expired) {
        if (result.status === 'completed') {
          const fresh = await fetchOrder(order_id);
          if (fresh) {
            setOrder(fresh);
            setExpired(false);
          }
        }
      } else {
        setRefundError(true);
        trackRefundFailed(order_id, 'expire-order returned unexpected result');
      }
    } catch (e) {
      console.error('expire-order call failed:', e);
      setRefundError(true);
      captureError(e, { stage: 'expire_order', order_id });
      trackRefundFailed(order_id, 'expire-order call threw');
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const data = await fetchOrder(order_id);
      if (data) {
        setOrder(data);
        if (data.otp || data.status === 'completed') {
          clearInterval(pollRef.current!);
          clearInterval(timerRef.current!);
          trackOtpReceived(order_id);
          trackOrderStatusChange(order_id, 'completed');
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (data.otp) {
            await sendOTPReceivedNotification(data.project_name || 'Platform', data.otp);
          }
          return;
        }
        if (data.order_reference) {
          try {
            const { otp } = await getOTP(data.order_reference);
            if (otp) {
              await supabase
                .from('orders')
                .update({ otp, status: 'completed' })
                .eq('id', order_id);
              setOrder((prev) => prev ? { ...prev, otp, status: 'completed' } : prev);
              clearInterval(pollRef.current!);
              clearInterval(timerRef.current!);
              await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              await sendOTPReceivedNotification(data.project_name || 'Platform', otp);
            }
          } catch {
            // Silently continue
          }
        }
      }
    }, OTP_POLL_INTERVAL);
  };

  // startTimerFromRemaining replaces the old startTimer().
  // It accepts the actual remaining seconds (accounting for elapsed time since
  // order creation) so the countdown is always accurate when reopening an order.
  // Timer is display-only: it counts down and flips the UI to "expired" state.
  // The actual expire-order call is handled by OrderContext's app-level watcher,
  // which fires every 30 s for any pending order past OTP_TIMEOUT regardless of
  // which screen is open. triggerExpiry() is only kept as a one-time fallback for
  // orders that are already past the window when this screen first opens.
  const startTimerFromRemaining = (initialRemaining: number) => {
    let remaining = initialRemaining;
    timerRef.current = setInterval(() => {
      remaining -= 1;
      setTimeLeft(remaining);
      if (remaining <= 0) {
        clearInterval(timerRef.current!);
        clearInterval(pollRef.current!);
        setExpired(true);
        // Do NOT call triggerExpiry() here — OrderContext handles expiry app-wide.
        // Show "processing refund" UI; the context watcher will update the order
        // status and the polling loop will pick up the change.
      }
    }, 1000);
  };

  const handleRequestOTP = async () => {
    if (!order?.order_reference) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setRequestingOTP(true);
    try {
      const { otp } = await getOTP(order.order_reference);
      if (otp) {
        await supabase.from('orders').update({ otp, status: 'completed' }).eq('id', order_id);
        setOrder((prev) => prev ? { ...prev, otp, status: 'completed' } : prev);
        clearInterval(pollRef.current!);
        clearInterval(timerRef.current!);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        await sendOTPReceivedNotification(order.project_name || 'Platform', otp);
      } else {
        setOtpRequested(true);
        startPolling();
      }
    } catch {
      setOtpRequested(true);
      startPolling();
    } finally {
      setRequestingOTP(false);
    }
  };

  const copyToClipboard = async (text: string, type: 'number' | 'otp' | 'ref') => {
    await Clipboard.setStringAsync(text);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (type === 'number') { setCopiedNumber(true); setTimeout(() => setCopiedNumber(false), 2000); }
    else if (type === 'otp') { setCopiedOTP(true); setTimeout(() => setCopiedOTP(false), 2000); }
    else { setCopiedRef(true); setTimeout(() => setCopiedRef(false), 2000); }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}m : ${String(s).padStart(2, '0')}s`;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleString('en-NG', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true,
    });
  };

  const otpReceived = !!(order?.otp || order?.status === 'completed');
  const statusColor = otpReceived ? Colors.success : expired ? Colors.error : '#F59E0B';
  const statusLabel = otpReceived ? 'Completed' : expired ? 'Expired' : 'Pending';

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
        <Text style={styles.headerTitle}>SMS Verification</Text>
        <View style={{ width: 36 }} />
      </View>

      {initialLoading ? (
        <View style={styles.loadingCenter}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      ) : (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      >
        {/* Main card */}
        <View style={styles.card}>
          {/* Service title */}
          <View style={styles.serviceHeader}>
            <View style={styles.serviceIconWrap}>
              <MaterialIcons name="phone-android" size={28} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.serviceTitle}>
                {order ? `${order.project_name} — ${order.country_name} SMS Verification` : 'Loading...'}
              </Text>
              {otpReceived && (
                <Text style={styles.successSub}>
                  OTP received successfully
                </Text>
              )}
            </View>
          </View>

          <View style={styles.divider} />

          {/* Mobile Number row */}
          <View style={styles.dataRow}>
            <Text style={styles.dataLabel}>Mobile Number</Text>
            {order?.phone_number ? (
              <TouchableOpacity
                style={styles.valueWithCopy}
                onPress={() => copyToClipboard(order.phone_number!, 'number')}
                activeOpacity={0.7}
              >
                <Text style={styles.phoneValue}>{order.phone_number}</Text>
                <MaterialIcons
                  name={copiedNumber ? 'check' : 'content-copy'}
                  size={16}
                  color={copiedNumber ? Colors.success : Colors.primary}
                />
              </TouchableOpacity>
            ) : (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={Colors.primary} />
                <Text style={styles.loadingLabel}>Assigning...</Text>
              </View>
            )}
          </View>

          <View style={styles.divider} />

          {/* Request OTP button - shown only when not yet received and not expired */}
          {!otpReceived && !expired && (
            <TouchableOpacity
              style={[styles.requestOtpBtn, (requestingOTP || !order?.phone_number) && styles.requestOtpBtnDisabled]}
              onPress={handleRequestOTP}
              disabled={requestingOTP || !order?.phone_number}
              activeOpacity={0.85}
            >
              {requestingOTP ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.requestOtpText}>
                  {otpRequested ? 'Refresh OTP/SMS' : 'Request OTP/SMS'}
                </Text>
              )}
            </TouchableOpacity>
          )}

          {/* SMS Inbox */}
          <View style={styles.smsInboxRow}>
            <View style={{ marginBottom: 6 }}>
              <Text style={styles.dataLabel}>SMS Inbox Message</Text>
            </View>
            <View style={styles.smsInboxField}>
              {otpReceived && order?.otp ? (
                <>
                  <Text style={styles.otpValue}>{order.otp}</Text>
                  <TouchableOpacity
                    style={styles.copyIconBtn}
                    onPress={() => copyToClipboard(order.otp!, 'otp')}
                    activeOpacity={0.8}
                  >
                    <MaterialIcons
                      name={copiedOTP ? 'check' : 'content-copy'}
                      size={18}
                      color="#FFFFFF"
                    />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <Text style={styles.waitingText}>
                    {expired ? 'OTP not received' : 'Waiting for OTP...'}
                  </Text>
                  <TouchableOpacity
                    style={[styles.copyIconBtn, styles.refreshBtn]}
                    onPress={handleRequestOTP}
                    disabled={requestingOTP || expired || !order?.phone_number}
                    activeOpacity={0.8}
                  >
                    {requestingOTP ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <MaterialIcons name="refresh" size={18} color="#FFFFFF" />
                    )}
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>

          {/* NB notice */}
          <View style={styles.nbRow}>
            <Text style={styles.nbLabel}>NB : </Text>
            <Text style={styles.nbText}>
              If no OTP is received before the timer runs out, your payment is automatically refunded to your wallet.
            </Text>
          </View>

          {/* Timer - shown while waiting */}
          {!otpReceived && !expired && (
            <Text style={styles.timerText}>{formatTime(timeLeft)}</Text>
          )}

          {expired && !otpReceived && (
            <View style={[styles.expiredBox, refundAmount ? styles.expiredBoxRefunded : null]}>
              <MaterialIcons
                name={refundAmount ? 'account-balance-wallet' : 'schedule'}
                size={18}
                color={refundAmount ? Colors.success : Colors.error}
              />
              <Text style={[styles.expiredText, refundAmount ? { color: Colors.success } : null]}>
                {refundAmount
                  ? `₦${Number(refundAmount).toLocaleString()} has been refunded to your wallet.`
                  : refundError
                  ? 'OTP window expired. Refund pending — contact support if not received within 24 hours.'
                  : 'OTP window expired. Processing refund...'}
              </Text>
            </View>
          )}

          <View style={styles.divider} />

          {/* Reference */}
          <View style={styles.dataRow}>
            <Text style={styles.dataLabel}>Reference</Text>
            {order?.order_reference ? (
              <TouchableOpacity
                style={styles.valueWithCopy}
                onPress={() => copyToClipboard(order.order_reference!, 'ref')}
                activeOpacity={0.7}
              >
                <Text style={styles.refValue} numberOfLines={1} ellipsizeMode="middle">
                  {order.order_reference}
                </Text>
                <MaterialIcons
                  name={copiedRef ? 'check' : 'content-copy'}
                  size={15}
                  color={copiedRef ? Colors.success : Colors.textSecondary}
                />
              </TouchableOpacity>
            ) : (
              <Text style={styles.dataValue}>-</Text>
            )}
          </View>

          <View style={styles.divider} />

          {/* Amount Paid */}
          <View style={styles.dataRow}>
            <Text style={styles.dataLabel}>Amount Paid</Text>
            <Text style={styles.dataValue}>
              ₦{order ? Number(order.amount_paid).toLocaleString('en-NG', { minimumFractionDigits: 2 }) : '-'}
            </Text>
          </View>

          <View style={styles.divider} />

          {/* Order Status */}
          <View style={styles.dataRow}>
            <Text style={styles.dataLabel}>Order Status</Text>
            <View style={[styles.statusPill, { backgroundColor: statusColor }]}>
              <Text style={styles.statusText}>{statusLabel}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          {/* Order Date */}
          <View style={styles.dataRow}>
            <Text style={styles.dataLabel}>Order Date</Text>
            <Text style={styles.dataValueSm}>{formatDate(order?.created_at)}</Text>
          </View>
        </View>

        {/* Support button when expired */}
        {expired && !otpReceived && refundError && (
          <TouchableOpacity
            style={styles.supportBtn}
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              showAlert('Contact Support', 'Email support@numvault.ng with your Order ID: ' + order_id);
            }}
            activeOpacity={0.8}
          >
            <MaterialIcons name="support-agent" size={16} color={Colors.black} />
            <Text style={styles.supportBtnText}>Contact Support</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.viewOrdersBtn}
          onPress={async () => {
            await Haptics.selectionAsync();
            router.push('/(tabs)/orders');
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.viewOrdersText}>View All Orders</Text>
          <MaterialIcons name="chevron-right" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
      </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loadingCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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

  // Card
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    overflow: 'hidden',
  },

  // Service header
  serviceHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    padding: Spacing.lg,
  },
  serviceIconWrap: {
    width: 44, height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  serviceTitle: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    lineHeight: 22,
  },
  successSub: {
    color: Colors.success,
    fontSize: FontSize.xs,
    marginTop: 4,
    fontWeight: FontWeight.medium,
  },

  divider: { height: 1, backgroundColor: Colors.surfaceBorder, marginHorizontal: Spacing.lg },

  // Data rows
  dataRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
    gap: Spacing.md,
  },
  dataLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.medium,
    flex: 1,
  },
  dataValue: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textAlign: 'right',
  },
  dataValueSm: {
    color: Colors.text,
    fontSize: 11,
    fontWeight: FontWeight.medium,
    textAlign: 'right',
    flex: 1.5,
  },
  phoneValue: {
    color: Colors.primary,
    fontSize: FontSize.md,
    fontWeight: FontWeight.bold,
    marginRight: 6,
  },
  refValue: {
    color: Colors.text,
    fontSize: 11,
    fontWeight: FontWeight.medium,
    flex: 1,
    marginRight: 6,
  },
  valueWithCopy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1.5,
    justifyContent: 'flex-end',
  },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  loadingLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },

  // Request OTP button
  requestOtpBtn: {
    backgroundColor: Colors.primary,
    marginHorizontal: Spacing.lg,
    marginVertical: Spacing.md,
    height: 50,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  requestOtpBtnDisabled: { opacity: 0.5 },
  requestOtpText: { color: Colors.black, fontSize: FontSize.md, fontWeight: FontWeight.bold },

  // SMS Inbox
  smsInboxRow: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 14,
  },
  smsInboxField: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
  },
  otpValue: {
    flex: 1,
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
    letterSpacing: 4,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
  },
  waitingText: {
    flex: 1,
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
    fontStyle: 'italic',
  },
  copyIconBtn: {
    width: 52,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  refreshBtn: { backgroundColor: Colors.surfaceBorder },

  // NB notice
  nbRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.lg,
    paddingBottom: 14,
    gap: 4,
  },
  nbLabel: { color: Colors.error, fontSize: FontSize.xs, fontWeight: FontWeight.bold },
  nbText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
    lineHeight: 18,
  },

  // Timer
  timerText: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: FontWeight.bold,
    textAlign: 'center',
    paddingBottom: Spacing.md,
    letterSpacing: 2,
  },

  // Status pill
  statusPill: {
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: Radius.full,
  },
  statusText: { color: '#FFFFFF', fontSize: FontSize.xs, fontWeight: FontWeight.bold },

  // Expired
  expiredBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.errorMuted,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    borderRadius: Radius.md,
    padding: Spacing.md,
  },
  expiredBoxRefunded: {
    backgroundColor: Colors.primaryMuted,
    borderWidth: 1,
    borderColor: Colors.success,
  },
  expiredText: { flex: 1, color: Colors.error, fontSize: FontSize.xs, lineHeight: 18 },

  supportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: Colors.error,
    borderRadius: Radius.md,
    height: 48,
  },
  supportBtnText: { color: Colors.black, fontWeight: FontWeight.bold, fontSize: FontSize.sm },

  viewOrdersBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: Spacing.md,
  },
  viewOrdersText: { color: Colors.textSecondary, fontSize: FontSize.sm },
});
