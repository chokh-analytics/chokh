import { createCollectRoute } from '@chokh/next/collect';

// /_pa/collect: forwards the tracker's batches to Chokh with the visitor's
// address, signed with CHOKH_PROXY_SECRET.
export const POST = createCollectRoute({
  url: process.env.NEXT_PUBLIC_CHOKH_URL,
  proxySecret: process.env.CHOKH_PROXY_SECRET,
});
