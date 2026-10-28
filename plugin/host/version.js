/**
 * Deep Connect — the single source of truth for versions.
 *
 * `PLUGIN_VERSION` is what the panel shows, what the relay client reports, and
 * what the updater compares against. `MIN_VERSION` is the hard floor: a client
 * older than this is refused by a v4.0.2+ station relay (426), and this release
 * itself renders only a "sealed" screen if it is ever built older than the floor.
 *
 * Keep this file dependency-free: station.js, relay.js and index.js all import it.
 *
 * @module dsh-deep-connect/version
 */
export const PLUGIN_VERSION = '4.2.0';
/** Versions below this are refused by the station and sealed by the panel. */
export const MIN_VERSION = '4.0.2';

/** Numeric semver comparison; returns -1, 0 or 1. `v` prefixes are ignored. */
export function compareVersion(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[-+.]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
