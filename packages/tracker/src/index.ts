// The entry esbuild bundles into a.js. Everything testable lives in tracker.ts
// so importing it does not boot a tracker.
import { start } from './tracker';

start(window, document);
