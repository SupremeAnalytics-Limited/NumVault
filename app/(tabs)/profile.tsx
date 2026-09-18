
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  StatusBar, TextInput, ActivityIndicator, Modal, KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth, useAlert, getSupabaseClient } from '@/template';
import { useWallet } from '@/hooks/useWallet';
import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { trackLogout, trackAccountDeleted, trackSupportInteraction } from '@/services/sentryService';

const ADMIN_EMAIL = 'oluwaferanmionabanjo@gmail.com';
const supabase = getSupabaseClient();

// ── Admin: pending backlog transfer ─────────────────────────────────────────
const BACKLOG_AMOUNT = 1422.14;
const BACKLOG_ORDER_REF = 'nv_6ab1baa4_1787954081117';

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { profile, refreshProfile } = useWallet();
  const { showAlert } = useAlert();
  const [newName, setNewName] = useState('');
  const [editingName, setEditingName] = useState(false);

  // Account deletion state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Admin transfer state
  const [transferring, setTransferring] = useState(false);
  const [transferResult, setTransferResult] = useState<{
    success: boolean;
    ref: string;
    message: string;
  } | null>(null);

  // Admin subaccount setup state
  const [settingUpSubaccount, setSettingUpSubaccount] = useState(false);
  const [subaccountResult, setSubaccountResult] = useState<{
    success: boolean;
    subaccount_code: string;
    already_existed: boolean;
    note: string;
    message: string;
  } | null>(null);

  const isAdmin = user?.email === ADMIN_EMAIL;

  useEffect(() => {
    if (user) refreshProfile();
  }, [user]);

  const handleUpdateName = async () => {
    if (!newName.trim()) return;
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase.from('user_profiles').update({ name: newName.trim() }).eq('id', user?.id);
    refreshProfile();
    setEditingName(false);
    showAlert('Name Updated', 'Your profile name has been updated.');
  };

  const handleLogout = async () => {
    showAlert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: async () => {
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          trackLogout();
          const { error } = await logout();
          if (!error) {
            router.replace('/login');
          }
        },
      },
    ]);
  };

  const handleSetupSubaccount = async () => {
    setSettingUpSubaccount(true);
    setSubaccountResult(null);
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const { data, error } = await supabase.functions.invoke('setup-subaccount', { body: {} });

      if (error) {
        let errorMessage = error.message;
        if (error instanceof FunctionsHttpError) {
          try {
            const textContent = await error.context?.text();
            errorMessage = textContent || error.message;
          } catch { /* keep original */ }
        }
        setSubaccountResult({ success: false, subaccount_code: '', already_existed: false, note: '', message: errorMessage });
        showAlert('Setup Failed', errorMessage);
      } else if (data?.success) {
        setSubaccountResult({
          success: true,
          subaccount_code: data.subaccount_code,
          already_existed: !!data.already_existed,
          note: data.note || '',
          message: '',
        });
        const title = data.fixed
          ? 'Split % Corrected'
          : data.already_existed ? 'Subaccount Found' : 'Subaccount Created';
        showAlert(
          title,
          `Code: ${data.subaccount_code}\n\n${data.note}`,
        );
      } else {
        const msg = data?.error || 'Unknown error';
        setSubaccountResult({ success: false, subaccount_code: '', already_existed: false, note: '', message: msg });
        showAlert('Setup Failed', msg);
      }
    } catch (err: any) {
      const msg = err?.message || 'Unexpected error';
      setSubaccountResult({ success: false, subaccount_code: '', already_existed: false, note: '', message: msg });
      showAlert('Error', msg);
    } finally {
      setSettingUpSubaccount(false);
    }
  };

  const handleAdminTransfer = async () => {
    showAlert(
      'Send Backlog Transfer',
      `Send ₦${BACKLOG_AMOUNT.toLocaleString()} to Socially.ng (Palmpay) for order ${BACKLOG_ORDER_REF}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send Now',
          style: 'default',
          onPress: async () => {
            setTransferring(true);
            setTransferResult(null);
            try {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

              const { data, error } = await supabase.functions.invoke('manual-transfer-test', {
                body: {
                  amount_naira: BACKLOG_AMOUNT,
                  order_reference: BACKLOG_ORDER_REF,
                  trigger_reason: 'manual_backlog_recovery',
                },
              });

              if (error) {
                let errorMessage = error.message;
                if (error instanceof FunctionsHttpError) {
                  try {
                    const textContent = await error.context?.text();
                    errorMessage = textContent || error.message;
                  } catch {
                    // keep original
                  }
                }
                setTransferResult({ success: false, ref: '', message: errorMessage });
                showAlert('Transfer Failed', errorMessage);
              } else if (data?.success) {
                const ref = data.paystack_transfer_reference || 'n/a';
                setTransferResult({
                  success: true,
                  ref,
                  message: `₦${BACKLOG_AMOUNT.toLocaleString()} sent. Ref: ${ref}`,
                });
                showAlert('Transfer Successful', `₦${BACKLOG_AMOUNT.toLocaleString()} sent to Socially.ng.\n\nPaystack ref: ${ref}`);
              } else {
                const msg = data?.error || 'Unknown error from transfer function';
                setTransferResult({ success: false, ref: '', message: msg });
                showAlert('Transfer Failed', msg);
              }
            } catch (err: any) {
              const msg = err?.message || 'Unexpected error';
              setTransferResult({ success: false, ref: '', message: msg });
              showAlert('Transfer Error', msg);
            } finally {
              setTransferring(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Profile</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {/* Avatar */}
        <View style={styles.avatarSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {(profile?.name || user?.email || 'U').charAt(0).toUpperCase()}
            </Text>
          </View>
          {editingName ? (
            <View style={styles.nameEdit}>
              <TextInput
                style={styles.nameInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="Enter your name"
                placeholderTextColor={Colors.textMuted}
                autoFocus
              />
              <TouchableOpacity onPress={handleUpdateName} style={styles.saveNameBtn}>
                <Text style={styles.saveNameText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingName(false)}>
                <MaterialIcons name="close" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.nameRow}
              onPress={() => {
                setNewName(profile?.name || '');
                setEditingName(true);
              }}
            >
              <Text style={styles.profileName}>{profile?.name || 'Add your name'}</Text>
              <MaterialIcons name="edit" size={14} color={Colors.textMuted} />
            </TouchableOpacity>
          )}
          <Text style={styles.profileEmail}>{user?.email}</Text>
        </View>

        {/* ── Acquisition Program Banner ── */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.programBanner}
            onPress={async () => {
              await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              router.push('/acquisition-program');
            }}
            activeOpacity={0.85}
          >
            <View style={styles.programBannerIcon}>
              <MaterialIcons name="groups" size={22} color={Colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.programBannerTitle}>Acquisition Program for Students</Text>
              <Text style={styles.programBannerSub}>Acquire customers · Qualify for paid Lead opportunity</Text>
            </View>
            <MaterialIcons name="chevron-right" size={20} color={Colors.primary} />
          </TouchableOpacity>
        </View>

        {/* Menu items */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Account</Text>
          <View style={styles.menuCard}>
            {[
              { icon: 'email', label: 'Email', value: user?.email },
              { icon: 'info-outline', label: 'App Version', value: '1.0.0' },
            ].map((item) => (
              <View key={item.label} style={styles.menuRow}>
                <MaterialIcons name={item.icon as any} size={18} color={Colors.textMuted} />
                <Text style={styles.menuLabel}>{item.label}</Text>
                <Text style={styles.menuValue}>{item.value}</Text>
              </View>
            ))}
            {/* Support / Customer Care link */}
            <TouchableOpacity
              style={[styles.menuRow, styles.supportRow]}
              onPress={async () => {
                await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                trackSupportInteraction('instagram_dm');
                Linking.openURL('https://ig.me/m/num.vault');
              }}
              activeOpacity={0.7}
            >
              <MaterialIcons name="support-agent" size={18} color={Colors.primary} />
              <Text style={[styles.menuLabel, { color: Colors.primary }]}>Support / Customer Care</Text>
              <MaterialIcons name="open-in-new" size={14} color={Colors.primary} />
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Admin panel — visible only to ADMIN_EMAIL ── */}
        {isAdmin ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Admin</Text>
            <View style={styles.adminCard}>
              <View style={styles.adminHeader}>
                <MaterialIcons name="admin-panel-settings" size={18} color={Colors.warning} />
                <Text style={styles.adminTitle}>Backlog Transfer</Text>
              </View>
              <Text style={styles.adminDesc}>
                Send ₦{BACKLOG_AMOUNT.toLocaleString(undefined, { minimumFractionDigits: 2 })} to Socially.ng
                (Palmpay 6635796668) for failed order{'\n'}
                <Text style={styles.adminRef}>{BACKLOG_ORDER_REF}</Text>
              </Text>

              {transferResult ? (
                <View style={[
                  styles.resultBadge,
                  { borderColor: transferResult.success ? Colors.success : Colors.error },
                ]}>
                  <MaterialIcons
                    name={transferResult.success ? 'check-circle' : 'error'}
                    size={16}
                    color={transferResult.success ? Colors.success : Colors.error}
                  />
                  <Text style={[
                    styles.resultText,
                    { color: transferResult.success ? Colors.success : Colors.error },
                  ]}>
                    {transferResult.message}
                  </Text>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.adminBtn, transferring && styles.adminBtnDisabled]}
                onPress={handleAdminTransfer}
                activeOpacity={0.8}
                disabled={transferring || transferResult?.success === true}
              >
                {transferring ? (
                  <ActivityIndicator size="small" color={Colors.black} />
                ) : (
                  <MaterialIcons name="send" size={16} color={Colors.black} />
                )}
                <Text style={styles.adminBtnText}>
                  {transferring
                    ? 'Sending...'
                    : transferResult?.success
                    ? 'Sent'
                    : 'Send Transfer'}
                </Text>
              </TouchableOpacity>
              {/* Admin Dashboard link */}
              <TouchableOpacity
                style={[styles.menuRow, { borderBottomWidth: 0 }]}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  router.push('/admin');
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name="dashboard" size={18} color={Colors.warning} />
                <Text style={[styles.menuLabel, { color: Colors.warning, flex: 1 }]}>Acquisition Admin Dashboard</Text>
                <MaterialIcons name="chevron-right" size={18} color={Colors.warning} />
              </TouchableOpacity>
            </View>

            {/* ── Setup Paystack Subaccount ── */}
            <View style={[styles.adminCard, { borderColor: Colors.primary, marginTop: Spacing.sm }]}>
              <View style={styles.adminHeader}>
                <MaterialIcons name="account-balance" size={18} color={Colors.primary} />
                <Text style={[styles.adminTitle, { color: Colors.primary }]}>Paystack Split Setup</Text>
              </View>
              <Text style={styles.adminDesc}>
                Create a Paystack subaccount for Socially.ng (Palmpay 6635796668).{`\n`}
                Main account keeps <Text style={{ color: Colors.text, fontWeight: FontWeight.semibold }}>28.57%</Text>, Socially.ng receives <Text style={{ color: Colors.primary, fontWeight: FontWeight.semibold }}>71.43%</Text> per sale.{`\n`}
                Idempotent — safe to run again if already set up.
              </Text>

              {subaccountResult ? (
                <View style={[styles.resultBadge, { borderColor: subaccountResult.success ? Colors.primary : Colors.error }]}>
                  <MaterialIcons
                    name={subaccountResult.success ? 'check-circle' : 'error'}
                    size={16}
                    color={subaccountResult.success ? Colors.primary : Colors.error}
                  />
                  <View style={{ flex: 1, gap: 4 }}>
                    {subaccountResult.success ? (
                      <>
                        <Text style={[styles.resultText, { color: Colors.primary }]}>
                          {subaccountResult.already_existed ? 'Already exists' : 'Created'}: <Text style={{ fontFamily: 'monospace' }}>{subaccountResult.subaccount_code}</Text>
                        </Text>
                        <Text style={[styles.resultText, { color: Colors.textSecondary }]}>
                          {subaccountResult.note}
                        </Text>
                        <Text style={[styles.resultText, { color: Colors.warning }]}>
                          Next: add secret SOCIALLY_SUBACCOUNT_CODE = {subaccountResult.subaccount_code}
                        </Text>
                      </>
                    ) : (
                      <Text style={[styles.resultText, { color: Colors.error }]}>{subaccountResult.message}</Text>
                    )}
                  </View>
                </View>
              ) : null}

              <TouchableOpacity
                style={[styles.adminBtn, { backgroundColor: Colors.primary }, settingUpSubaccount && styles.adminBtnDisabled]}
                onPress={handleSetupSubaccount}
                activeOpacity={0.8}
                disabled={settingUpSubaccount}
              >
                {settingUpSubaccount ? (
                  <ActivityIndicator size="small" color={Colors.black} />
                ) : (
                  <MaterialIcons name="account-balance" size={16} color={Colors.black} />
                )}
                <Text style={styles.adminBtnText}>
                  {settingUpSubaccount ? 'Setting up...' : 'Setup / Check Subaccount'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
        {/* ──────────────────────────────────────────────── */}

        {/* Legal */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Legal</Text>
          <View style={styles.menuCard}>
            {[
              { icon: 'privacy-tip', label: 'Privacy Policy', url: 'https://numvault-6fwcjfqw.manus.space/privacy' },
              { icon: 'gavel', label: 'Terms of Service', url: 'https://numvault-6fwcjfqw.manus.space/terms' },
            ].map((item, index, arr) => (
              <TouchableOpacity
                key={item.label}
                style={[
                  styles.menuRow,
                  index === arr.length - 1 && { borderBottomWidth: 0 },
                ]}
                onPress={async () => {
                  await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  await WebBrowser.openBrowserAsync(item.url);
                }}
                activeOpacity={0.7}
              >
                <MaterialIcons name={item.icon as any} size={18} color={Colors.textMuted} />
                <Text style={[styles.menuLabel, { color: Colors.text }]}>{item.label}</Text>
                <MaterialIcons name="chevron-right" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* ── Sign Out + Delete Account — compact row group ── */}
        <View style={[styles.section, { marginBottom: Spacing.xl }]}>
          <View style={styles.menuCard}>
            <TouchableOpacity
              style={styles.menuRow}
              onPress={handleLogout}
              activeOpacity={0.7}
            >
              <MaterialIcons name="logout" size={18} color={Colors.error} />
              <Text style={[styles.menuLabel, { color: Colors.error, flex: 1 }]}>Sign Out</Text>
              <MaterialIcons name="chevron-right" size={18} color={Colors.error} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.menuRow, { borderBottomWidth: 0 }]}
              onPress={() => { setDeleteConfirmText(''); setShowDeleteModal(true); }}
              activeOpacity={0.7}
            >
              <MaterialIcons name="delete-forever" size={18} color={Colors.error} />
              <Text style={[styles.menuLabel, { color: Colors.error, flex: 1 }]}>Delete Account</Text>
              <MaterialIcons name="chevron-right" size={18} color={Colors.error} />
            </TouchableOpacity>
          </View>
          <Text style={styles.deleteAccountHint}>
            Permanently removes your account, wallet, orders, and all personal data.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* ── Account Deletion Confirmation Modal ── */}
      <Modal
        visible={showDeleteModal}
        animationType="slide"
        transparent
        onRequestClose={() => !deleting && setShowDeleteModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.deleteModal}>
            {/* Header */}
            <View style={styles.deleteModalHeader}>
              <View style={styles.deleteModalIcon}>
                <MaterialIcons name="warning" size={26} color={Colors.error} />
              </View>
              <TouchableOpacity
                onPress={() => !deleting && setShowDeleteModal(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.deleteModalClose}
              >
                <MaterialIcons name="close" size={20} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={styles.deleteModalTitle}>Delete Account?</Text>
            <Text style={styles.deleteModalSubtitle}>
              This will permanently delete:
            </Text>

            {[
              'Your wallet balance and top-up history',
              'All orders and purchased numbers',
              'Your saved card information',
              'Your profile and login credentials',
            ].map((item) => (
              <View key={item} style={styles.deleteListRow}>
                <MaterialIcons name="remove-circle" size={14} color={Colors.error} />
                <Text style={styles.deleteListText}>{item}</Text>
              </View>
            ))}

            <View style={styles.deleteWarningBox}>
              <MaterialIcons name="info-outline" size={14} color={Colors.warning} />
              <Text style={styles.deleteWarningText}>
                Any pending wallet balance will be lost and cannot be recovered.
              </Text>
            </View>

            {/* Confirmation input */}
            <View style={styles.deleteInputSection}>
              <Text style={styles.deleteInputLabel}>
                Type <Text style={styles.deleteInputKeyword}>DELETE</Text> to confirm
              </Text>
              <TextInput
                style={[
                  styles.deleteInput,
                  deleteConfirmText === 'DELETE' && styles.deleteInputValid,
                ]}
                value={deleteConfirmText}
                onChangeText={setDeleteConfirmText}
                placeholder="Type DELETE here"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                editable={!deleting}
              />
            </View>

            {/* Actions */}
            <View style={styles.deleteModalActions}>
              <TouchableOpacity
                style={styles.deleteCancelBtn}
                onPress={() => setShowDeleteModal(false)}
                disabled={deleting}
                activeOpacity={0.8}
              >
                <Text style={styles.deleteCancelText}>Keep Account</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.deleteConfirmBtn,
                  (deleteConfirmText !== 'DELETE' || deleting) && styles.deleteConfirmBtnDisabled,
                ]}
                onPress={async () => {
                  if (deleteConfirmText !== 'DELETE' || deleting) return;
                  await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  setDeleting(true);
                  try {
                    const { data: sessionData } = await supabase.auth.getSession();
                    const token = sessionData?.session?.access_token;
                    const { data, error } = await supabase.functions.invoke('delete-account', {
                      body: {},
                      headers: token ? { Authorization: `Bearer ${token}` } : {},
                    });
                    if (error) {
                      let msg = error.message;
                      if ((error as any) instanceof FunctionsHttpError) {
                        try { msg = (await (error as any).context?.text()) || msg; } catch { /* keep */ }
                      }
                      showAlert('Deletion Failed', msg);
                      setDeleting(false);
                      return;
                    }
                    // Success — sign out locally and redirect
                    trackAccountDeleted();
                    await logout();
                    setShowDeleteModal(false);
                    router.replace('/onboarding');
                  } catch (err: any) {
                    showAlert('Error', err?.message || 'Unexpected error. Please try again.');
                    setDeleting(false);
                  }
                }}
                disabled={deleteConfirmText !== 'DELETE' || deleting}
                activeOpacity={0.8}
              >
                {deleting ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <MaterialIcons name="delete-forever" size={16} color={Colors.white} />
                )}
                <Text style={styles.deleteConfirmText}>
                  {deleting ? 'Deleting...' : 'Delete Everything'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  headerTitle: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  avatarSection: { alignItems: 'center', paddingVertical: Spacing.xl, gap: Spacing.sm },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Colors.primaryMuted,
    borderWidth: 2,
    borderColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: Colors.primary, fontSize: FontSize.xxxl, fontWeight: FontWeight.bold },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.semibold },
  profileEmail: { color: Colors.textSecondary, fontSize: FontSize.sm },
  nameEdit: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  nameInput: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 40,
    color: Colors.text,
    fontSize: FontSize.md,
    minWidth: 160,
  },
  saveNameBtn: {
    backgroundColor: Colors.primary,
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  saveNameText: { color: Colors.black, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
  section: { paddingHorizontal: Spacing.lg, marginBottom: Spacing.lg },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    fontWeight: FontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Spacing.sm,
  },
  menuCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    padding: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.surfaceBorder,
  },
  menuLabel: { flex: 1, color: Colors.textSecondary, fontSize: FontSize.sm },
  menuValue: { color: Colors.text, fontSize: FontSize.sm },
  supportRow: { borderBottomWidth: 0 },
  // (logoutBtn and deleteAccountBtn replaced by inline menuRow styling)
  deleteAccountHint: {
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },

  // Deletion modal
  modalOverlay: {
    flex: 1,
    backgroundColor: Colors.overlay,
    justifyContent: 'flex-end',
  },
  deleteModal: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    padding: Spacing.lg,
    gap: Spacing.md,
    paddingBottom: Spacing.xxl,
  },
  deleteModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.xs,
  },
  deleteModalIcon: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    backgroundColor: Colors.errorMuted,
    borderWidth: 1,
    borderColor: Colors.error,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteModalClose: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteModalTitle: {
    color: Colors.text,
    fontSize: FontSize.xl,
    fontWeight: FontWeight.bold,
  },
  deleteModalSubtitle: {
    color: Colors.textSecondary,
    fontSize: FontSize.sm,
    marginBottom: Spacing.xs,
  },
  deleteListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  deleteListText: { color: Colors.textSecondary, fontSize: FontSize.sm, flex: 1 },
  deleteWarningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    backgroundColor: Colors.warningMuted,
    borderWidth: 1,
    borderColor: Colors.warning,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginTop: Spacing.xs,
  },
  deleteWarningText: { flex: 1, color: Colors.warning, fontSize: FontSize.xs, lineHeight: 18 },
  deleteInputSection: { gap: Spacing.sm },
  deleteInputLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },
  deleteInputKeyword: { color: Colors.error, fontWeight: FontWeight.bold },
  deleteInput: {
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    height: 48,
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: FontWeight.semibold,
    letterSpacing: 2,
  },
  deleteInputValid: {
    borderColor: Colors.error,
    backgroundColor: Colors.errorMuted,
  },
  deleteModalActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  deleteCancelBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md,
    paddingVertical: 14,
  },
  deleteCancelText: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  deleteConfirmBtn: {
    flex: 1.4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.error,
    borderRadius: Radius.md,
    paddingVertical: 14,
  },
  deleteConfirmBtnDisabled: { opacity: 0.4 },
  deleteConfirmText: { color: Colors.white, fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  // Admin panel styles
  programBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primary,
    borderRadius: Radius.lg,
    padding: Spacing.md,
  },
  programBannerIcon: {
    width: 44, height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  programBannerTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  programBannerSub: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },

  adminCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.warning,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  adminHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  adminTitle: { color: Colors.warning, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  adminDesc: { color: Colors.textSecondary, fontSize: FontSize.sm, lineHeight: 20 },
  adminRef: { color: Colors.textMuted, fontSize: FontSize.xs, fontFamily: 'monospace' },
  resultBadge: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    padding: Spacing.sm,
  },
  resultText: { flex: 1, fontSize: FontSize.xs, lineHeight: 18 },
  adminBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.warning,
    borderRadius: Radius.md,
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.xs,
  },
  adminBtnDisabled: { opacity: 0.6 },
  adminBtnText: { color: Colors.black, fontWeight: FontWeight.semibold, fontSize: FontSize.sm },
});
