// The one door to storage, for everything in this package. The contract itself
// lives in @chokh/store beside the conformance suite that proves it, so an
// adapter package can depend on it without depending on the server; this file
// keeps the import path every service already uses.
export * from '@chokh/store';
