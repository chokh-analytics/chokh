import { signUserId } from '@chokh/sdk-node';

// On your server, where the page reads its own session: a signature the page
// passes to identify, so nobody can claim to be somebody else.
export function identifySignature(userId: string): string {
  return signUserId(process.env.CHOKH_IDENTIFY_SECRET ?? '', 'my_site', userId);
}
