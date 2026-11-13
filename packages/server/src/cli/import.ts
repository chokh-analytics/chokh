// node packages/server/dist/cli/import.js ...  (bin: chokh-import)
//
// The importers as one command, opening the store the server would open from
// the same environment: DATABASE_URL for PostgreSQL, MONGODB_URI for MongoDB.
// It refuses to run without one, because the memory store keeps nothing and an
// import into it would vanish with the process. See import/command.ts for the
// command itself and the README for the sources.
import { env } from '../config/env.js';
import { runImportCommand, USAGE } from '../import/command.js';
import { openStore } from '../plugins/store.js';
import { createMemoryPresence } from '../store/AnalyticsStore.js';

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help')) {
    console.warn(USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  if (env.DATABASE_URL === undefined && env.MONGODB_URI === undefined) {
    console.error('Set DATABASE_URL (PostgreSQL) or MONGODB_URI (MongoDB): an import into memory would vanish with this process.');
    return 1;
  }
  const presence = createMemoryPresence();
  const { store } = await openStore(presence);
  try {
    return await runImportCommand(argv, {
      store,
      // The report is the command's output, so it goes to stdout.
      print: (line) => process.stdout.write(`${line}\n`),
      now: () => Date.now(),
    });
  } finally {
    await store.close();
    await presence.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
