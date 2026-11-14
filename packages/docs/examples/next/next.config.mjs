import { withChokh } from '@chokh/next/config';

/** @type {import('next').NextConfig} */
const nextConfig = {};

// Serves a.js, v.js and e.js under /_pa, from your own origin.
export default withChokh(nextConfig, { url: process.env.NEXT_PUBLIC_CHOKH_URL });
