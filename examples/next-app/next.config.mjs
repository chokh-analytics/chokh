import { withChokh } from '@chokh/next/config';

// The tracker's scripts served from this app's own origin, /_pa/a.js and the
// rest, rewritten to the Chokh server. The collect path is the route in
// app/%5Fpa/collect, not a rewrite.
export default withChokh({}, { url: process.env.CHOKH_URL });
