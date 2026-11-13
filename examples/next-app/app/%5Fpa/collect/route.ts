import { createCollectRoute } from '@chokh/next/collect';

// The first-party collect path, /_pa/collect. The folder is %5Fpa because a
// folder whose name starts with an underscore is private in the App Router.
export const POST = createCollectRoute({
  url: process.env.CHOKH_URL,
  proxySecret: process.env.CHOKH_PROXY_SECRET,
});
