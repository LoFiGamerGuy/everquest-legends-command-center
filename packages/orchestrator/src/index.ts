/**
 * @eqlcc/orchestrator — headless ingestion orchestrator (issue #19).
 *
 * Composes @eqlcc/log-tailer + @eqlcc/log-parser (parser + EntityResolver) +
 * @eqlcc/database into a durable, byte-offset-resumable {@link IngestPipeline}
 * with replay and live modes. See pipeline.ts for the pipeline contract and
 * resolver-store.ts for the resolver-snapshot persistence used to survive
 * mid-file restarts.
 */

export { IngestPipeline } from "./pipeline.js";
export type {
  BatchOutcome,
  IngestPipelineOptions,
  PipelineMode,
  ReplayResult,
} from "./pipeline.js";
export {
  loadResolverSnapshot,
  pipelineMigrations,
  resolverSnapshotMigration,
  saveResolverSnapshot,
} from "./resolver-store.js";
