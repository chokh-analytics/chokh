export { schema, sequences, DECLARED_INDEX_COUNT } from './schema.js';
export type { ColumnSchema, IndexSchema, TableSchema } from './schema.js';
export { apply, verify, formatReport, runCli } from './migrate.js';
export type { ApplyOptions, MigrateReport, TableReport } from './migrate.js';
export {
  PARTITION_FLOOR_DAYS,
  createPartitionManager,
  inPartitionWindow,
  listPartitions,
  monthOf,
  monthsFor,
  partitionWindow,
} from './partitions.js';
export type { Month, PartitionManager, PartitionRow } from './partitions.js';
export {
  MIN_SERVER_VERSION,
  PostgresSetupError,
  assertSupported,
  inspectServer,
} from './server.js';
export type { ServerInfo, SetupErrorCode } from './server.js';
export { LOCK_MIGRATE, LOCK_NAMESPACE, LOCK_PARTITIONS } from './locks.js';
