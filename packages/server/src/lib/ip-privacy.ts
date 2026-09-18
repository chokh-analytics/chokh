import ipaddr from 'ipaddr.js';

import type { IpMode } from '../store/AnalyticsStore.js';

// The site's IP mode, applied before anything is stored. Anonymised zeroes the
// last octet of an IPv4 address and everything past the first four groups of an
// IPv6 one, which is the same cut.
export function applyIpMode(ip: string, mode: IpMode): string | undefined {
  if (mode === 'none') {
    return undefined;
  }
  if (mode === 'full') {
    return ip;
  }
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(ip);
  } catch {
    // An address that cannot be parsed cannot be anonymised, so it is dropped.
    return undefined;
  }
  const bytes = parsed.toByteArray();
  const keep = parsed.kind() === 'ipv4' ? 3 : 8;
  for (let i = keep; i < bytes.length; i++) {
    bytes[i] = 0;
  }
  return ipaddr.fromByteArray(bytes).toString();
}
