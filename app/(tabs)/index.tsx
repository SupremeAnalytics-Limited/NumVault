import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  StatusBar, TextInput, ActivityIndicator, Animated,
  RefreshControl, SectionList,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/template';
import {
  getServiceList, getServicePrice, getCountries, getPackagesForCountry,
  detectCountryRegion, getServicePopularityRank,
  ServiceItem, ServiceCategory, CountryRegion, Country, Package,
} from '@/services/sociallyService';
import { PLATFORM_ICONS } from '@/constants/config';
import { Colors, Spacing, Radius, FontSize, FontWeight } from '@/constants/theme';

// ── Constants ────────────────────────────────────────────────────────────────

type ProviderCode = 'server-b' | 'server-a';

const PROVIDERS: { code: ProviderCode; label: string; desc: string; icon: string }[] = [
  { code: 'server-b', label: 'US Numbers', desc: 'US-based services', icon: 'flag' },
  { code: 'server-a', label: 'Other Countries', desc: 'Coming soon', icon: 'public' },
];

const SERVICE_CATEGORIES: ServiceCategory[] = ['All', 'Social', 'Messaging', 'Finance', 'Shopping', 'Other'];
const COUNTRY_REGIONS: CountryRegion[] = ['All', 'Popular', 'Africa', 'Europe', 'Americas', 'Asia', 'Middle East', 'Other'];

const CATEGORY_ICONS: Record<ServiceCategory, string> = {
  All: 'apps', Social: 'people', Messaging: 'chat-bubble',
  Finance: 'account-balance-wallet', Shopping: 'shopping-cart', Other: 'more-horiz',
};

const REGION_ICONS: Record<CountryRegion, string> = {
  All: 'apps', Popular: 'star', Africa: 'public', Europe: 'location-city',
  Americas: 'flag', Asia: 'travel-explore', 'Middle East': 'mosque', Other: 'more-horiz',
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface CountryWithRegion extends Country {
  region: CountryRegion;
}

interface ServiceSection {
  category: ServiceCategory;
  data: ServiceItem[];
}

interface CountrySection {
  region: CountryRegion;
  data: CountryWithRegion[];
}

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();

  const [provider, setProvider] = useState<ProviderCode>('server-b');

  // Server B
  const [allServices, setAllServices] = useState<ServiceItem[]>([]);
  const [loadingServices, setLoadingServices] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCat, setActiveCat] = useState<ServiceCategory>('All');
  const priceCache = useRef<Map<string, Package | null>>(new Map());
  const [fetchingPrice, setFetchingPrice] = useState(false);
  const [sheetPriceReady, setSheetPriceReady] = useState(false);

  // Server A
  const [allCountries, setAllCountries] = useState<CountryWithRegion[]>([]);
  const [loadingCountries, setLoadingCountries] = useState(false);
  const [activeRegion, setActiveRegion] = useState<CountryRegion>('All');
  const [countrySearch, setCountrySearch] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<Country | null>(null);
  const [countryPackages, setCountryPackages] = useState<Package[]>([]);
  const [loadingPackages, setLoadingPackages] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);

  // Bottom sheet
  const [sheetService, setSheetService] = useState<ServiceItem | null>(null);
  const [sheetPackage, setSheetPackage] = useState<{ country: Country; pkg: Package } | null>(null);
  const sheetAnim = useRef(new Animated.Value(0)).current;

  // ── Provider switch ───────────────────────────────────────────────────────

  useEffect(() => {
    setSearchQuery('');
    setCountrySearch('');
    setActiveCat('All');
    setActiveRegion('All');
    setSelectedCountry(null);
    setCountryPackages([]);
    setSheetService(null);
    setSheetPackage(null);
    if (provider === 'server-b') loadServerB();
    else loadServerA();
  }, [provider]);

  // ── Server B ──────────────────────────────────────────────────────────────

  const loadServerB = async (isRefresh = false) => {
    if (isRefresh) { setRefreshing(true); priceCache.current.clear(); }
    else setLoadingServices(true);
    try {
      const items = await getServiceList('server-b');
      const sorted = [...items].sort((a, b) => {
        const ra = getServicePopularityRank(a.title);
        const rb = getServicePopularityRank(b.title);
        if (ra !== rb) return ra - rb;
        return a.title.localeCompare(b.title);
      });
      setAllServices(sorted);
    } catch (e) {
      console.error('Server B load error:', e);
    } finally {
      setLoadingServices(false);
      setRefreshing(false);
    }
  };

  const serverBSections: ServiceSection[] = React.useMemo(() => {
    const filtered = allServices.filter((s) => {
      const q = searchQuery.toLowerCase();
      return (
        (s.title.toLowerCase().includes(q) || s.country_code.toLowerCase().includes(q)) &&
        (activeCat === 'All' || s.category === activeCat)
      );
    });

    if (activeCat !== 'All') {
      return [{ category: activeCat, data: filtered }];
    }

    const order: ServiceCategory[] = ['Social', 'Messaging', 'Finance', 'Shopping', 'Other'];
    return order
      .map((cat) => ({ category: cat, data: filtered.filter((s) => s.category === cat) }))
      .filter((sec) => sec.data.length > 0);
  }, [allServices, searchQuery, activeCat]);

  const catCounts = React.useMemo(() =>
    SERVICE_CATEGORIES.reduce((acc, cat) => {
      acc[cat] = cat === 'All' ? allServices.length : allServices.filter((s) => s.category === cat).length;
      return acc;
    }, {} as Record<ServiceCategory, number>),
    [allServices]
  );

  // ── Server A ──────────────────────────────────────────────────────────────

  const loadServerA = async () => {
    setLoadingCountries(true);
    try {
      const list = await getCountries('server-a');
      const enriched: CountryWithRegion[] = list.map((c) => ({
        ...c,
        region: detectCountryRegion(c.title),
      }));
      enriched.sort((a, b) => {
        const popOrder: CountryRegion[] = ['Popular', 'Africa', 'Americas', 'Europe', 'Asia', 'Middle East', 'Other'];
        const ra = popOrder.indexOf(a.region);
        const rb = popOrder.indexOf(b.region);
        if (ra !== rb) return ra - rb;
        return a.title.localeCompare(b.title);
      });
      setAllCountries(enriched);
    } catch (e) {
      console.error('Server A load error:', e);
    } finally {
      setLoadingCountries(false);
    }
  };

  const selectCountry = async (country: CountryWithRegion) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedCountry(country);
    setCountryPackages([]);
    setPackageError(null);
    setLoadingPackages(true);
    try {
      const pkgs = await getPackagesForCountry('server-a', country.country_code);
      const sorted = [...pkgs].sort((a, b) => {
        const ra = getServicePopularityRank(a.project_name);
        const rb = getServicePopularityRank(b.project_name);
        if (ra !== rb) return ra - rb;
        return a.project_name.localeCompare(b.project_name);
      });
      setCountryPackages(sorted);
      if (sorted.length === 0) setPackageError(`No platforms available for ${country.title}`);
    } catch (e: any) {
      setPackageError(e?.message || 'Failed to load platforms');
    } finally {
      setLoadingPackages(false);
    }
  };

  const serverASections: CountrySection[] = React.useMemo(() => {
    const q = countrySearch.toLowerCase();
    const filtered = allCountries.filter((c) =>
      c.title.toLowerCase().includes(q) &&
      (activeRegion === 'All' || c.region === activeRegion)
    );

    if (activeRegion !== 'All') {
      return [{ region: activeRegion, data: filtered }];
    }

    const order: CountryRegion[] = ['Popular', 'Africa', 'Americas', 'Europe', 'Asia', 'Middle East', 'Other'];
    return order
      .map((r) => ({ region: r, data: filtered.filter((c) => c.region === r) }))
      .filter((sec) => sec.data.length > 0);
  }, [allCountries, countrySearch, activeRegion]);

  const regionCounts = React.useMemo(() =>
    COUNTRY_REGIONS.reduce((acc, r) => {
      acc[r] = r === 'All' ? allCountries.length : allCountries.filter((c) => c.region === r).length;
      return acc;
    }, {} as Record<CountryRegion, number>),
    [allCountries]
  );

  // ── Bottom Sheet ──────────────────────────────────────────────────────────

  const openSheetService = async (svc: ServiceItem) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetService(svc);
    setSheetPackage(null);
    setSheetPriceReady(false);
    Animated.spring(sheetAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();

    const cached = priceCache.current.get(svc.country_code);
    if (cached !== undefined) {
      if (cached) setSheetService((prev) => prev ? { ...prev, package: cached } : prev);
      setSheetPriceReady(true);
      return;
    }
    setFetchingPrice(true);
    try {
      const pkg = await getServicePrice('server-b', svc.country_code);
      priceCache.current.set(svc.country_code, pkg);
      setSheetService((prev) => prev && prev.country_code === svc.country_code
        ? { ...prev, package: pkg ?? prev.package } : prev);
      setSheetPriceReady(true);
    } catch {
      priceCache.current.set(svc.country_code, null);
      setSheetPriceReady(true);
    } finally {
      setFetchingPrice(false);
    }
  };

  const openSheetPackage = async (country: Country, pkg: Package) => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSheetPackage({ country, pkg });
    setSheetService(null);
    setSheetPriceReady(true);
    Animated.spring(sheetAnim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();
  };

  const closeSheet = () => {
    Animated.timing(sheetAnim, { toValue: 0, duration: 220, useNativeDriver: true }).start(() => {
      setSheetService(null);
      setSheetPackage(null);
    });
  };

  const proceedToCheckout = async () => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    let params: Record<string, string> = {};
    if (sheetService) {
      params = {
        provider_code: 'server-b',
        country_code: sheetService.country_code,
        country_name: sheetService.title,
        project_code: sheetService.package.project_code,
        project_name: sheetService.package.project_name,
        price: String(sheetService.package.displayPrice),
        wholesale_price: String(sheetService.package.price),
      };
    } else if (sheetPackage) {
      params = {
        provider_code: 'server-a',
        country_code: sheetPackage.country.country_code,
        country_name: sheetPackage.country.title,
        project_code: sheetPackage.pkg.project_code,
        project_name: sheetPackage.pkg.project_name,
        price: String(sheetPackage.pkg.displayPrice),
        wholesale_price: String(sheetPackage.pkg.price),
      };
    } else return;
    closeSheet();
    setTimeout(() => router.push({ pathname: '/checkout', params }), 250);
  };

  const sheetTranslateY = sheetAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] });
  const sheetPrice = sheetService
    ? (sheetService.package.displayPrice || 0)
    : sheetPackage ? sheetPackage.pkg.displayPrice : 0;
  const sheetHasPrice = sheetPrice > 0;
  const sheetTitle = sheetService
    ? sheetService.title
    : sheetPackage ? `${sheetPackage.pkg.project_name} — ${sheetPackage.country.title}` : '';
  const sheetProvider = sheetService ? 'Server B' : 'Server A';
  const sheetCat = sheetService ? sheetService.category : null;
  const isSheetOpen = !!(sheetService || sheetPackage);

  const firstName = user?.username?.split(' ')[0] || user?.email?.split('@')[0] || 'there';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hey, {firstName} 👋</Text>
          <Text style={styles.tagline}>Pick a service, get your number.</Text>
        </View>
      </View>

      {/* Provider tabs */}
      <View style={styles.providerRow}>
        {PROVIDERS.map((p) => {
          const active = provider === p.code;
          return (
            <TouchableOpacity
              key={p.code}
              style={[styles.providerTab, active && styles.providerTabActive]}
              onPress={async () => { await Haptics.selectionAsync(); setProvider(p.code); }}
              activeOpacity={0.8}
            >
              <MaterialIcons name={p.icon as any} size={16} color={active ? Colors.primary : Colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.providerTabLabel, active && styles.providerTabLabelActive]}>{p.label}</Text>
                <Text style={styles.providerTabDesc}>{p.desc}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ═══ SERVER B ═══ */}
      {provider === 'server-b' && (
        <>
          {/* Search */}
          <View style={styles.searchWrap}>
            <View style={styles.searchBar}>
              <MaterialIcons name="search" size={18} color={Colors.textMuted} />
              <TextInput
                style={styles.searchInput}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search TikTok, WhatsApp, PayPal..."
                placeholderTextColor={Colors.textMuted}
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <MaterialIcons name="close" size={16} color={Colors.textMuted} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {loadingServices ? (
            <View style={styles.loadingContainer}>
              <View style={styles.loadingCard}>
                <ActivityIndicator color={Colors.primary} size="large" />
                <Text style={styles.loadingTitle}>Loading services...</Text>
                <Text style={styles.loadingSubtitle}>Fetching service list from Server B</Text>
              </View>
            </View>
          ) : (
            <>
              {/* Category chips — outer View allocates vertical space so pills are never clipped */}
              <View style={styles.chipWrap}>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                >
                  {SERVICE_CATEGORIES.filter((c) => catCounts[c] > 0 || c === 'All').map((cat) => {
                    const active = activeCat === cat;
                    return (
                      <TouchableOpacity
                        key={cat}
                        style={[styles.chip, active && styles.chipActive]}
                        onPress={async () => { await Haptics.selectionAsync(); setActiveCat(cat); }}
                        activeOpacity={0.8}
                      >
                        <MaterialIcons name={CATEGORY_ICONS[cat] as any} size={13} color={active ? Colors.black : Colors.textSecondary} />
                        <Text style={[styles.chipText, active && styles.chipTextActive]}>{cat}</Text>
                        <View style={[styles.chipBadge, active && styles.chipBadgeActive]}>
                          <Text style={[styles.chipBadgeText, active && styles.chipBadgeTextActive]}>
                            {catCounts[cat]}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              {serverBSections.every((s) => s.data.length === 0) || serverBSections.length === 0 ? (
                <View style={styles.emptyCenter}>
                  <View style={styles.emptyIcon}>
                    <MaterialIcons name="search-off" size={32} color={Colors.textMuted} />
                  </View>
                  <Text style={styles.emptyTitle}>No results</Text>
                  <Text style={styles.emptySub}>
                    {searchQuery ? `Nothing matches "${searchQuery}"` : `No services in ${activeCat}`}
                  </Text>
                  <TouchableOpacity style={styles.clearBtn} onPress={() => { setSearchQuery(''); setActiveCat('All'); }}>
                    <Text style={styles.clearBtnText}>Clear filters</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <SectionList
                  sections={serverBSections}
                  keyExtractor={(item) => item.country_code}
                  showsVerticalScrollIndicator={false}
                  stickySectionHeadersEnabled={false}
                  contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 32 }]}
                  refreshControl={
                    <RefreshControl refreshing={refreshing} onRefresh={() => loadServerB(true)} tintColor={Colors.primary} colors={[Colors.primary]} />
                  }
                  renderSectionHeader={({ section }) => (
                    <View style={styles.sectionHeader}>
                      <View style={styles.sectionHeaderLeft}>
                        <View style={styles.sectionIconWrap}>
                          <MaterialIcons name={CATEGORY_ICONS[section.category] as any} size={14} color={Colors.primary} />
                        </View>
                        <Text style={styles.sectionTitle}>{section.category}</Text>
                      </View>
                      <Text style={styles.sectionCount}>{section.data.length} services</Text>
                    </View>
                  )}
                  renderItem={({ item, index, section }) => {
                    if (index % 2 !== 0) return null;
                    const next = section.data[index + 1];
                    return (
                      <View style={styles.row}>
                        <ServiceCard service={item} onPress={() => openSheetService(item)} />
                        {next
                          ? <ServiceCard service={next} onPress={() => openSheetService(next)} />
                          : <View style={styles.cardWrap} />
                        }
                      </View>
                    );
                  }}
                />
              )}
            </>
          )}
        </>
      )}

      {/* ═══ SERVER A — COMING SOON ═══ */}
      {provider === 'server-a' && (
        <View style={styles.comingSoonContainer}>
          <View style={styles.comingSoonCard}>
            <View style={styles.comingSoonIconWrap}>
              <MaterialIcons name="public" size={40} color={Colors.primary} />
            </View>
            <Text style={styles.comingSoonTitle}>Other Countries</Text>
            <Text style={styles.comingSoonSub}>
              Temporary phone numbers from multiple countries are coming soon. You will be able to verify services using numbers from the UK, Canada, Germany, Nigeria, and many more.
            </Text>
            <View style={styles.comingSoonBadge}>
              <MaterialIcons name="schedule" size={13} color={Colors.primary} />
              <Text style={styles.comingSoonBadgeText}>Coming Soon</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.switchUsBtn}
            onPress={async () => { await Haptics.selectionAsync(); setProvider('server-b'); }}
            activeOpacity={0.85}
          >
            <MaterialIcons name="flag" size={16} color={Colors.black} />
            <Text style={styles.switchUsBtnText}>Browse US Numbers Instead</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ═══ BOTTOM SHEET ═══ */}
      {isSheetOpen && (
        <>
          <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={closeSheet} />
          <Animated.View
            style={[styles.sheet, { paddingBottom: insets.bottom + 24, transform: [{ translateY: sheetTranslateY }] }]}
          >
            <View style={styles.sheetHandle} />

            <View style={styles.sheetServiceRow}>
              <View style={styles.sheetServiceIcon}>
                <MaterialIcons
                  name={(PLATFORM_ICONS[sheetTitle.split(' —')[0]?.split(' -')[0]?.trim()] || 'phone-android') as any}
                  size={26}
                  color={Colors.primary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sheetServiceName} numberOfLines={2}>{sheetTitle}</Text>
                <View style={styles.sheetTagRow}>
                  <View style={styles.serverDot} />
                  <Text style={styles.sheetTagText}>{sheetProvider} · SMS Verification</Text>
                  {sheetCat && (
                    <>
                      <Text style={styles.sheetTagSep}>·</Text>
                      <View style={styles.sheetCatTag}>
                        <MaterialIcons name={CATEGORY_ICONS[sheetCat] as any} size={10} color={Colors.primary} />
                        <Text style={styles.sheetCatText}>{sheetCat}</Text>
                      </View>
                    </>
                  )}
                </View>
              </View>
            </View>

            <View style={styles.sheetDetails}>
              {[
                { label: 'You receive', value: 'Real temporary phone number' },
                { label: 'OTP delivery', value: 'Auto-captured within 10 min' },
                { label: 'Refund policy', value: 'Auto-refund if no OTP in 5 mins', green: true },
              ].map((row) => (
                <View key={row.label} style={styles.sheetRow}>
                  <Text style={styles.sheetRowLabel}>{row.label}</Text>
                  <Text style={[styles.sheetRowValue, row.green && { color: Colors.primary }]}>{row.value}</Text>
                </View>
              ))}
              <View style={[styles.sheetRow, styles.sheetPriceRow]}>
                <Text style={styles.sheetPriceLabel}>Total</Text>
                {fetchingPrice
                  ? <ActivityIndicator color={Colors.primary} size="small" />
                  : <Text style={sheetHasPrice ? styles.sheetPrice : styles.sheetPriceNA}>
                      {sheetHasPrice ? `₦${sheetPrice.toLocaleString()}` : 'Not available'}
                    </Text>
                }
              </View>
            </View>

            <TouchableOpacity
              style={[styles.payBtn, (!sheetHasPrice || fetchingPrice) && styles.payBtnDisabled]}
              onPress={proceedToCheckout}
              disabled={!sheetHasPrice || fetchingPrice}
              activeOpacity={0.88}
            >
              {fetchingPrice
                ? <ActivityIndicator color={Colors.black} size="small" />
                : (
                  <>
                    <MaterialIcons name="lock" size={16} color={Colors.black} />
                    <Text style={styles.payBtnText}>
                      {sheetHasPrice ? `Pay ₦${sheetPrice.toLocaleString()}` : 'Price unavailable'}
                    </Text>
                  </>
                )
              }
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={closeSheet}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </Animated.View>
        </>
      )}
    </View>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFlagEmoji(code: string): string {
  const c = (code || '').toUpperCase();
  if (!c || c.length !== 2 || !/^[A-Z]{2}$/.test(c)) return '🌐';
  return String.fromCodePoint(...c.split('').map((ch) => ch.charCodeAt(0) + 127397));
}

// ── Service Card (Server B) ───────────────────────────────────────────────────

function ServiceCard({ service, onPress }: { service: ServiceItem; onPress: () => void }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const onPressIn = () => Animated.spring(scaleAnim, { toValue: 0.95, useNativeDriver: true, speed: 30 }).start();
  const onPressOut = () => Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, speed: 30 }).start();

  const parts = service.title.split(' - ');
  const mainName = parts[0]?.trim() || service.title;
  const subName = parts[1]?.trim() || null;
  const isPopular = getServicePopularityRank(service.title) < 18;

  return (
    <Animated.View style={[styles.cardWrap, { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        style={styles.card}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
      >
        <View style={styles.cardTop}>
          <View style={styles.cardIconWrap}>
            <MaterialIcons name={(PLATFORM_ICONS[mainName] || 'phone-android') as any} size={22} color={Colors.primary} />
          </View>
          {isPopular && (
            <View style={styles.popularTag}>
              <MaterialIcons name="star" size={9} color={Colors.primary} />
              <Text style={styles.popularTagText}>Popular</Text>
            </View>
          )}
        </View>
        <Text style={styles.cardName} numberOfLines={2}>{mainName}</Text>
        {subName && <Text style={styles.cardSub} numberOfLines={1}>{subName}</Text>}
        <Text style={styles.cardPrice}>
          {service.package.displayPrice > 0 ? `₦${service.package.displayPrice.toLocaleString()}` : 'Tap for price'}
        </Text>
        <View style={styles.cardFooter}>
          <Text style={styles.cardBuyLabel}>Get number</Text>
          <MaterialIcons name="arrow-forward" size={13} color={Colors.primary} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Package Card (Server A) ───────────────────────────────────────────────────

function PackageCard({ pkg, rank, onPress }: { pkg: Package; rank: number; onPress: () => void }) {
  const isTopRank = getServicePopularityRank(pkg.project_name) < 18;
  return (
    <TouchableOpacity style={styles.packageItem} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.packageIconWrap}>
        <MaterialIcons
          name={(PLATFORM_ICONS[pkg.project_name] || 'phone-android') as any}
          size={20}
          color={Colors.primary}
        />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.packageName} numberOfLines={1}>{pkg.project_name}</Text>
          {isTopRank && (
            <View style={styles.popularTag}>
              <MaterialIcons name="star" size={9} color={Colors.primary} />
              <Text style={styles.popularTagText}>Popular</Text>
            </View>
          )}
        </View>
        <Text style={styles.packagePrice}>₦{pkg.displayPrice.toLocaleString()}</Text>
      </View>
      <MaterialIcons name="arrow-forward-ios" size={12} color={Colors.textMuted} />
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },

  header: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.md },
  greeting: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  tagline: { color: Colors.textSecondary, fontSize: FontSize.xs, marginTop: 2 },

  providerRow: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, gap: Spacing.sm },
  providerTab: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, paddingHorizontal: Spacing.md, paddingVertical: 10,
  },
  providerTabActive: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  providerTabLabel: { color: Colors.textSecondary, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  providerTabLabelActive: { color: Colors.primary },
  providerTabDesc: { color: Colors.textMuted, fontSize: 10, marginTop: 1 },
  serverDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.primary },

  searchWrap: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, paddingHorizontal: Spacing.md, height: 46,
  },
  searchInput: { flex: 1, color: Colors.text, fontSize: FontSize.sm, includeFontPadding: false },

  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.lg },
  loadingCard: {
    backgroundColor: Colors.surface, borderRadius: Radius.xl, borderWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.xl, alignItems: 'center', gap: Spacing.md, width: '100%',
  },
  loadingTitle: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold },
  loadingSubtitle: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center' },

  // Chip bar — outer View owns the vertical space; ScrollView just scrolls horizontally
  chipWrap: {
    paddingTop: 6,
    paddingBottom: Spacing.md,
  },
  chipRow: {
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.full, paddingHorizontal: 14, paddingVertical: 9,
    minHeight: 38,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: FontWeight.semibold },
  chipTextActive: { color: Colors.black, fontWeight: FontWeight.bold },
  chipBadge: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.full,
    paddingHorizontal: 6, paddingVertical: 2, minWidth: 22, alignItems: 'center',
  },
  chipBadgeActive: { backgroundColor: 'rgba(0,0,0,0.20)' },
  chipBadgeText: { color: Colors.textMuted, fontSize: 10, fontWeight: FontWeight.bold },
  chipBadgeTextActive: { color: Colors.black },

  // Coming soon (Server A)
  comingSoonContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.xl, gap: Spacing.lg,
  },
  comingSoonCard: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.xl, padding: Spacing.xl, alignItems: 'center', gap: Spacing.md,
    width: '100%',
  },
  comingSoonIconWrap: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  comingSoonTitle: { color: Colors.text, fontSize: FontSize.xl, fontWeight: FontWeight.bold },
  comingSoonSub: {
    color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center',
    lineHeight: 22,
  },
  comingSoonBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.full,
    paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.3)',
    marginTop: 4,
  },
  comingSoonBadgeText: { color: Colors.primary, fontSize: 13, fontWeight: FontWeight.bold },
  switchUsBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: Colors.primary, borderRadius: Radius.md,
    height: 52, width: '100%',
  },
  switchUsBtnText: { color: Colors.black, fontSize: FontSize.sm, fontWeight: FontWeight.bold },

  // Section header (Server B)
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.sm, marginTop: Spacing.md,
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionIconWrap: {
    width: 26, height: 26, borderRadius: Radius.sm,
    backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.2)',
  },
  sectionTitle: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  sectionCount: { color: Colors.textMuted, fontSize: 11 },

  listContent: { paddingHorizontal: Spacing.lg, paddingTop: 0 },
  row: { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.md },

  // Service card
  cardWrap: { flex: 1 },
  card: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.lg, padding: Spacing.md, gap: 6, minHeight: 148,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  cardIconWrap: {
    width: 40, height: 40, borderRadius: Radius.md, backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.2)',
  },
  popularTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.full,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: 'rgba(0,200,83,0.25)',
  },
  popularTagText: { color: Colors.primary, fontSize: 9, fontWeight: FontWeight.bold },
  cardName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold, lineHeight: 18 },
  cardSub: { color: Colors.textMuted, fontSize: 10 },
  cardPrice: { color: Colors.primary, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  cardBuyLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: FontWeight.medium },

  // Empty
  emptyCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.md, paddingHorizontal: Spacing.xl },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.surfaceBorder, alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  emptySub: { color: Colors.textSecondary, fontSize: FontSize.sm, textAlign: 'center' },
  clearBtn: {
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, paddingHorizontal: Spacing.lg, paddingVertical: 10,
  },
  clearBtnText: { color: Colors.textSecondary, fontSize: FontSize.sm },

  // Server A layout
  serverALayout: { flex: 1, flexDirection: 'row' },
  countryList: {
    width: 130,
    borderRightWidth: 1,
    borderRightColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.xs,
  },
  countrySectionHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: Spacing.sm, paddingVertical: 5, marginTop: 4,
  },
  countrySectionTitle: { color: Colors.primary, fontSize: 10, fontWeight: FontWeight.bold, textTransform: 'uppercase', letterSpacing: 0.5 },
  countryItem: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 10, paddingHorizontal: Spacing.sm,
    borderRadius: Radius.sm, marginBottom: 1,
  },
  countryItemActive: { backgroundColor: Colors.primaryMuted, borderWidth: 1, borderColor: 'rgba(0,200,83,0.2)' },
  countryFlag: { fontSize: 16 },
  countryName: { flex: 1, color: Colors.textSecondary, fontSize: 11, fontWeight: FontWeight.medium },
  countryNameActive: { color: Colors.primary },

  packagesPanel: { flex: 1, paddingHorizontal: Spacing.sm },
  packagesPanelHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: Spacing.sm, paddingHorizontal: 4, marginBottom: 4,
  },
  packagesPanelFlag: { fontSize: 18 },
  packagesPanelTitle: { flex: 1, color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.bold },
  packagesPanelBadge: {
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.full,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  packagesPanelBadgeText: { color: Colors.primary, fontSize: 11, fontWeight: FontWeight.bold },

  selectHint: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md },
  selectHintText: { color: Colors.textMuted, fontSize: FontSize.sm, textAlign: 'center', lineHeight: 20 },

  packageItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.surfaceBorder,
    borderRadius: Radius.md, padding: Spacing.md, marginBottom: Spacing.sm,
  },
  packageIconWrap: {
    width: 36, height: 36, borderRadius: Radius.sm, backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
  },
  packageName: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.semibold },
  packagePrice: { color: Colors.primary, fontSize: FontSize.xs, fontWeight: FontWeight.bold, marginTop: 2 },

  // Backdrop
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: Colors.overlay },

  // Sheet
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl,
    borderTopWidth: 1, borderColor: Colors.surfaceBorder,
    padding: Spacing.lg, paddingTop: Spacing.md,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: { width: 0, height: -4 },
    elevation: 16,
  },
  sheetHandle: {
    width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.surfaceBorder,
    alignSelf: 'center', marginBottom: Spacing.lg,
  },
  sheetServiceRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, marginBottom: Spacing.lg },
  sheetServiceIcon: {
    width: 52, height: 52, borderRadius: Radius.md, backgroundColor: Colors.primaryMuted,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: Colors.primary, flexShrink: 0,
  },
  sheetServiceName: { color: Colors.text, fontSize: FontSize.lg, fontWeight: FontWeight.bold, lineHeight: 24 },
  sheetTagRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4, flexWrap: 'wrap' },
  sheetTagText: { color: Colors.textSecondary, fontSize: FontSize.xs },
  sheetTagSep: { color: Colors.textMuted, fontSize: FontSize.xs },
  sheetCatTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: Colors.primaryMuted, borderRadius: Radius.full,
    paddingHorizontal: 7, paddingVertical: 2,
  },
  sheetCatText: { color: Colors.primary, fontSize: 10, fontWeight: FontWeight.semibold },

  sheetDetails: {
    backgroundColor: Colors.surfaceElevated, borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    paddingHorizontal: Spacing.md, marginBottom: Spacing.lg,
  },
  sheetRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: Colors.surfaceBorder,
  },
  sheetPriceRow: { borderBottomWidth: 0 },
  sheetRowLabel: { color: Colors.textSecondary, fontSize: FontSize.sm },
  sheetRowValue: { color: Colors.text, fontSize: FontSize.sm, fontWeight: FontWeight.medium, flex: 1, textAlign: 'right' },
  sheetPriceLabel: { color: Colors.text, fontSize: FontSize.md, fontWeight: FontWeight.semibold },
  sheetPrice: { color: Colors.primary, fontSize: FontSize.xxl, fontWeight: FontWeight.bold },
  sheetPriceNA: { color: Colors.textMuted, fontSize: FontSize.md, fontStyle: 'italic' },

  payBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
    backgroundColor: Colors.primary, borderRadius: Radius.md, height: 54, marginBottom: Spacing.sm,
  },
  payBtnDisabled: { opacity: 0.5 },
  payBtnText: { color: Colors.black, fontSize: FontSize.md, fontWeight: FontWeight.bold },
  cancelBtn: { alignItems: 'center', paddingVertical: Spacing.sm },
  cancelText: { color: Colors.textSecondary, fontSize: FontSize.sm },
});
