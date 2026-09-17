import React, { useEffect, useRef, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  StatusBar, ActivityIndicator, TextInput, AppState,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/template';
import { useOrders } from '@/hooks/useOrders';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

const STATUS_COLORS = {
  pending: Colors.warning,
  completed: Colors.success,
  expired: Colors.error,
};

const STATUS_ICONS = {
  pending: 'schedule',
  completed: 'check-circle',
  expired: 'cancel',
};

type StatusFilter = 'all' | 'pending' | 'completed' | 'expired';

const STATUS_FILTER_LABELS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'completed', label: 'Completed' },
  { key: 'expired', label: 'Expired' },
];

export default function OrdersScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { orders, loading, refreshOrders, refreshOrderStatus } = useOrders();
  const { user } = useAuth();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [serviceFilter, setServiceFilter] = useState<string>('all');
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef(AppState.currentState);

  const pendingOrderIds = orders
    .filter((o) => o.status === 'pending')
    .map((o) => o.id);
  const hasPending = pendingOrderIds.length > 0;

  useEffect(() => {
    if (user) refreshOrders();
  }, [user]);

  // Auto-refresh: while pending orders exist, poll only their status every 10 s
  // (targeted fetch instead of full list re-pull). On foreground, do a full refresh.
  useEffect(() => {
    if (!user) return;

    if (hasPending) {
      // Poll individual pending order statuses — much cheaper than full list
      pollIntervalRef.current = setInterval(() => {
        pendingOrderIds.forEach((id) => refreshOrderStatus(id));
      }, 10_000);
    } else {
      // No pending orders — no polling needed
      pollIntervalRef.current = null;
    }

    const sub = AppState.addEventListener('change', (next) => {
      if (appStateRef.current.match(/inactive|background/) && next === 'active') {
        // Full refresh on foreground to catch any state we missed
        refreshOrders();
      }
      appStateRef.current = next;
    });

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      sub.remove();
    };
  }, [user, hasPending, pendingOrderIds.join(',')]);


  // Unique service names derived from orders
  const serviceNames = useMemo(() => {
    const names = Array.from(new Set(orders.map((o) => o.project_name).filter(Boolean)));
    return names.sort();
  }, [orders]);

  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const matchStatus = statusFilter === 'all' || o.status === statusFilter;
      const matchService = serviceFilter === 'all' || o.project_name === serviceFilter;
      return matchStatus && matchService;
    });
  }, [orders, statusFilter, serviceFilter]);

  const handleOrderPress = async (orderId: string) => {
    await Haptics.selectionAsync();
    router.push({ pathname: '/number-display', params: { order_id: orderId } });
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-NG', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Orders</Text>
        <TouchableOpacity
          onPress={async () => {
            await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            refreshOrders();
          }}
          style={styles.refreshBtn}
        >
          <MaterialIcons name="refresh" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* ── Compact filter bar ── */}
      <View style={styles.filterBar}>
        {/* Search */}
        <View style={styles.searchWrap}>
          <MaterialIcons name="search" size={15} color={Colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={serviceFilter === 'all' ? '' : ''}
            placeholder="Search service or country..."
            placeholderTextColor={Colors.textMuted}
            onChangeText={() => {}}
            editable={false}
            pointerEvents="none"
          />
        </View>

        {/* Status + Service chips in ONE horizontal scroll */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
        >
          {/* Status chips */}
          {STATUS_FILTER_LABELS.map(({ key, label }) => {
            const count = key === 'all' ? orders.length : orders.filter((o) => o.status === key).length;
            const active = statusFilter === key && serviceFilter === 'all';
            return (
              <TouchableOpacity
                key={`status_${key}`}
                style={[
                  styles.chip,
                  active && styles.chipActive,
                  key !== 'all' && !active && { borderColor: `${STATUS_COLORS[key as keyof typeof STATUS_COLORS]}40` },
                ]}
                onPress={async () => {
                  await Haptics.selectionAsync();
                  setStatusFilter(key);
                  setServiceFilter('all');
                }}
                activeOpacity={0.8}
              >
                {key !== 'all' && (
                  <MaterialIcons
                    name={STATUS_ICONS[key as keyof typeof STATUS_ICONS] as any}
                    size={11}
                    color={active ? Colors.black : STATUS_COLORS[key as keyof typeof STATUS_COLORS]}
                  />
                )}
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
                <View style={[styles.chipBadge, active && styles.chipBadgeActive]}>
                  <Text style={[styles.chipBadgeText, active && styles.chipBadgeTextActive]}>{count}</Text>
                </View>
              </TouchableOpacity>
            );
          })}

          {/* Divider */}
          {serviceNames.length > 0 && (
            <View style={styles.chipDivider} />
          )}

          {/* Service chips — dynamic from order history */}
          {serviceNames.map((name) => {
            const active = serviceFilter === name;
            const count = orders.filter((o) => o.project_name === name).length;
            return (
              <TouchableOpacity
                key={`svc_${name}`}
                style={[styles.chip, active && styles.chipServiceActive]}
                onPress={async () => {
                  await Haptics.selectionAsync();
                  setServiceFilter(active ? 'all' : name);
                  setStatusFilter('all');
                }}
                activeOpacity={0.8}
              >
                <MaterialIcons name="phone-android" size={11} color={active ? Colors.black : Colors.textSecondary} />
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{name}</Text>
                <View style={[styles.chipBadge, active && styles.chipBadgeActive]}>
                  <Text style={[styles.chipBadgeText, active && styles.chipBadgeTextActive]}>{count}</Text>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Orders list */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.primary} size="large" />
        </View>
      ) : filteredOrders.length === 0 ? (
        <View style={styles.empty}>
          <MaterialIcons name="receipt-long" size={48} color={Colors.textMuted} />
          <Text style={styles.emptyTitle}>
            {orders.length === 0 ? 'No Orders Yet' : 'No matches'}
          </Text>
          <Text style={styles.emptyText}>
            {orders.length === 0
              ? 'Your purchased verification numbers will appear here'
              : 'Try a different filter'}
          </Text>
          {orders.length > 0 && (
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => { setStatusFilter('all'); setServiceFilter('all'); }}
            >
              <Text style={styles.clearBtnText}>Clear filters</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: Spacing.lg, paddingTop: Spacing.sm }}
        >
          {filteredOrders.map((order) => (
            <TouchableOpacity
              key={order.id}
              style={styles.orderCard}
              onPress={() => handleOrderPress(order.id)}
              activeOpacity={0.8}
            >
              <View style={styles.orderTop}>
                <View style={styles.orderLeft}>
                  <View style={styles.orderIcon}>
                    <MaterialIcons name="phone-android" size={20} color={Colors.primary} />
                  </View>
                  <View style={styles.orderMeta}>
                    <Text style={styles.orderProject}>{order.project_name}</Text>
                    <Text style={styles.orderCountry}>{order.country_name}</Text>
                    <Text style={styles.orderDate}>{formatDate(order.created_at)}</Text>
                  </View>
                </View>
                <View style={styles.orderRight}>
                  <View style={[styles.statusBadge, { backgroundColor: `${STATUS_COLORS[order.status]}20` }]}>
                    <MaterialIcons
                      name={STATUS_ICONS[order.status] as any}
                      size={11}
                      color={STATUS_COLORS[order.status]}
                    />
                    <Text style={[styles.statusText, { color: STATUS_COLORS[order.status] }]}>
                      {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                    </Text>
                  </View>
                  <MaterialIcons name="chevron-right" size={18} color={Colors.textMuted} />
                </View>
              </View>

              <View style={styles.orderFooter}>
                <Text style={styles.orderAmount}>
                  ₦{Number(order.amount_paid).toLocaleString()}
                </Text>
                {order.otp ? (
                  <View style={styles.otpPreview}>
                    <MaterialIcons name="sms" size={11} color={Colors.success} />
                    <Text style={styles.otpPreviewText}>OTP received</Text>
                  </View>
                ) : order.status === 'pending' ? (
                  <View style={styles.otpPreview}>
                    <ActivityIndicator size={10} color={Colors.warning} />
                    <Text style={[styles.otpPreviewText, { color: Colors.warning }]}>Awaiting OTP</Text>
                  </View>
                ) : (
                  <View style={styles.otpPreview}>
                    <MaterialIcons name="info-outline" size={11} color={Colors.textMuted} />
                    <Text style={[styles.otpPreviewText, { color: Colors.textMuted }]}>Tap to view</Text>
                  </View>
                )}
              </View>
            </TouchableOpacity>
          ))}
          <View style={{ height: 20 }} />
        </ScrollView>
      )}
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
    paddingTop: Spacing.sm,
    paddingBottom: 6,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  refreshBtn: {
    padding: 7,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },

  // ── Filter bar (search + chips, no gap) ──
  filterBar: {
    gap: 6,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: Spacing.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingHorizontal: 10,
    height: 36,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 13,
    includeFontPadding: false,
  },
  chipRow: {
    paddingHorizontal: Spacing.lg,
    gap: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    height: 28,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipServiceActive: { backgroundColor: Colors.primaryMuted, borderColor: Colors.primary },
  chipText: { color: Colors.textSecondary, fontSize: 11, fontWeight: FontWeight.semibold },
  chipTextActive: { color: Colors.black, fontWeight: FontWeight.bold },
  chipBadge: {
    backgroundColor: Colors.surfaceElevated,
    borderRadius: Radius.full,
    paddingHorizontal: 4,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: 'center',
  },
  chipBadgeActive: { backgroundColor: 'rgba(0,0,0,0.20)' },
  chipBadgeText: { color: Colors.textMuted, fontSize: 9, fontWeight: FontWeight.bold },
  chipBadgeTextActive: { color: Colors.black },
  chipDivider: {
    width: 1,
    height: 16,
    backgroundColor: Colors.surfaceBorder,
    marginHorizontal: 2,
  },

  // ── List ──
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: FontWeight.semibold,
  },
  emptyText: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    textAlign: 'center',
    lineHeight: 22,
  },
  orderCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    marginBottom: 10,
    gap: Spacing.sm,
  },
  orderTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  orderLeft: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, flex: 1 },
  orderIcon: {
    width: 38,
    height: 38,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  orderMeta: { flex: 1, gap: 2 },
  orderProject: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
  },
  orderCountry: {
    color: Colors.textSecondary,
    fontSize: FontSize.xs,
  },
  orderDate: {
    color: Colors.textMuted,
    fontSize: 10,
  },
  orderRight: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: Radius.full,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  statusText: { fontSize: 10, fontWeight: FontWeight.semibold },
  orderFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.surfaceBorder,
  },
  orderAmount: {
    color: Colors.primary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.bold,
  },
  otpPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  otpPreviewText: {
    color: Colors.success,
    fontSize: FontSize.xs,
    fontWeight: FontWeight.medium,
  },
  clearBtn: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: 10,
  },
  clearBtnText: { color: Colors.textSecondary, fontSize: FontSize.sm },
});
