import { createHash, randomBytes } from 'node:crypto';

// The cookieless visitor id: a salted hash of the address, the user agent and
// the site, with the salt rotated daily so the id cannot outlive the day or be
// walked back to a person. A site running in persistent mode sends its own id
// and this is not used.
//
// The salt lives in this process. A restart therefore starts new cookieless
// visitors for the rest of the day, which is a known cost of having no shared
// store; AN-STO01 can move it behind the adapter.
export interface VisitorIdSource {
  derive(siteId: string, ip: string, userAgent: string, now: number): string;
}

function dayOf(now: number): number {
  return Math.floor(now / 86_400_000);
}

export function createVisitorIdSource(): VisitorIdSource {
  let salt = randomBytes(16);
  let day = -1;

  return {
    derive(siteId: string, ip: string, userAgent: string, now: number): string {
      const today = dayOf(now);
      if (today !== day) {
        day = today;
        salt = randomBytes(16);
      }
      return createHash('sha256')
        .update(salt)
        .update(siteId)
        .update(ip)
        .update(userAgent)
        .digest('base64url')
        .slice(0, 22);
    },
  };
}
