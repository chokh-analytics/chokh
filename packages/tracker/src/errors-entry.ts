// The entry esbuild bundles into e.js. Everything testable lives in errors.ts
// so importing it does not start listening.
import { watchErrors } from './errors';

watchErrors(window);
