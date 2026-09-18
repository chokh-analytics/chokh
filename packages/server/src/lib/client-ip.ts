import ipaddr from 'ipaddr.js';

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
}

export interface ClientIpOptions {
  trustProxy: string[];
  realIpHeader: string;
}

export function clientIp(source: ClientIpSource, options: ClientIpOptions): string {
  if (options.realIpHeader === 'x-forwarded-for') {
    return source.ip;
  }
  if (!isTrustedProxy(source.peer, options.trustProxy)) {
    return source.ip;
  }
  const raw = Array.isArray(source.header) ? source.header[0] : source.header;
  const value = raw?.split(',')[0]?.trim();
  return value === undefined || value === '' ? source.ip : value;
}
