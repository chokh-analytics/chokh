import { signForwardedAddress } from '@chokh/sdk-node';

const CHOKH_URL = process.env.CHOKH_URL ?? ''; // https://analytics.example.com
const SECRET = process.env.CHOKH_PROXY_SECRET ?? ''; // the same as the server's

// Your handler for POST /_pa/collect. `address` is the visitor's address as
// your own edge reports it, never a header the visitor could send.
export async function forwardCollect(request: Request, address: string): Promise<Response> {
  const ts = Date.now();
  const headers = new Headers({
    'content-type': request.headers.get('content-type') ?? 'text/plain',
    'user-agent': request.headers.get('user-agent') ?? '',
    'x-chokh-forwarded-for': address,
    'x-chokh-forwarded-sig': `${ts}.${signForwardedAddress(SECRET, address, ts)}`,
  });
  // The browser's own Origin and Client Hints, read by the collector as they
  // would be without a proxy.
  for (const [name, value] of request.headers) {
    if (name === 'origin' || name.startsWith('sec-ch-ua')) {
      headers.set(name, value);
    }
  }
  return fetch(`${CHOKH_URL}/api/collect`, { method: 'POST', headers, body: await request.text() });
}
