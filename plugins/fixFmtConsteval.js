/**
 * Expo config plugin: fixFmtConsteval
 *
 * React Native 0.79 (Expo SDK 53) pulls in fmt 11.0.2, which turns on C++20
 * `consteval` format-string checks whenever the compiler claims support. The
 * Apple clang in Xcode 26 (required by App Store Connect since ITMS-90725)
 * rejects those checks: "call to consteval function
 * fmt::basic_format_string<...> is not a constant expression".
 *
 * fmt 11.0.2 offers no external override, so after `pod install` we flip
 * FMT_USE_CONSTEVAL to 0 in the downloaded Pods/fmt/include/fmt/base.h.
 * Formatting still works; strings are just checked at runtime instead.
 * Remove this plugin after upgrading to Expo SDK 54+ (React Native 0.81+).
 */
const { withPodfile } = require('@expo/config-plugins');

const MARKER = '# [fixFmtConsteval]';
const SNIPPET = `
    ${MARKER} Xcode 26 rejects fmt 11.0.2's consteval format strings.
    fmt_base = File.join(installer.sandbox.root.to_s, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      fmt_src = File.read(fmt_base)
      fmt_patched = fmt_src.gsub('#  define FMT_USE_CONSTEVAL 1', '#  define FMT_USE_CONSTEVAL 0')
      if fmt_patched != fmt_src
        File.chmod(0644, fmt_base)
        File.write(fmt_base, fmt_patched)
        Pod::UI.puts '[fixFmtConsteval] Disabled consteval in fmt/base.h'
      end
    end
`;

module.exports = function fixFmtConsteval(config) {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents;
    if (podfile.includes(MARKER)) return cfg;
    const anchor = /post_install do \|installer\|\n/;
    if (!anchor.test(podfile)) {
      throw new Error('[fixFmtConsteval] Could not find post_install block in Podfile');
    }
    cfg.modResults.contents = podfile.replace(anchor, (m) => m + SNIPPET);
    return cfg;
  });
};
