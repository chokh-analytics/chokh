import ipaddr from 'ipaddr.js';

import { verifyForwardedAddress } from './forwarded-address.js';

// Who the visitor is depends on who is allowed to say so. Only a peer inside
// TRUST_PROXY may set the real IP header, otherwise anyone could claim any
// address.
export function isTrustedProxy(address: string | undefined, cidrs: string[]): boolean {
  if (address === undefined || cidrs.length === 0) {
    return false;
  }
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return false;
  }
  for (const cidr of cidrs) {
    try {
      const range = ipaddr.parseCIDR(cidr);
      if (parsed.kind() === range[0].kind() && parsed.match(range)) {
        return true;
      }
    } catch {
      // A malformed CIDR trusts nobody rather than everybody.
    }
  }
  return false;
}

export interface ClientIpSource {
  // What Fastify resolved, which already honours X-Forwarded-For when
  // trustProxy is configured.
  ip: string;
  peer: string | undefined;
  header: string | string[] | undefined;
  // Only the signed forwarded mode reads these two: the X-Chokh-Forwarded-Sig
  // value, and the moment the request arrived that the signature's ts is
  // measured against. Unset means now, which is what it is.
  signature?: string | string[] | undefined;
  now?: number;
}

export interface ClientIpOptions {
  trustProxy: string[];
  realIpHeader: string;
  // The secret the first-party proxy signs a forwarded address with. Required
  // at boot for the x-chokh-forwarded-for mode and meaningless for the others.
  proxySecret?: string | undefined;
}

function first(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(',')[0]?.trim() ?? '';
}

export function clientIp(source: ClientIpSource, options: ClientIpOptions): string {
  if (options.realIpHeader === 'x-forwarded-for') {
    return source.ip;
  }
  if (options.realIpHeader === 'x-chokh-forwarded-for') {
    // Here the signature is the trust, not the peer: the proxy is somebody
    // else's infrastructure and the hop in front of it is trusted already. An
    // address that does not check out is never a refusal, because a beacon
    // cannot read one; the peer chain answers instead.
    const forwarded = first(source.header);
    const signature = first(source.signature);
    const at = source.now ?? Date.now();
    return verifyForwardedAddress(options.proxySecret, forwarded, signature, at)
      ? forwarded
      : source.ip;
  }
  if (!isTrustedProxy(source.peer, options.trustProxy)) {
    return source.ip;
  }
  const value = first(source.header);
  return value === '' ? source.ip : value;
}
