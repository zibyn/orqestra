import { createPostgresBackend, Worker } from 'bullmq'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is not set')

const worker = new Worker(
  'agent-runs',
  async (job) => {
    // TODO: spawn pi in RPC mode and stream events into the db
    console.log(`job ${job.id}`, job.data)
  },
  // bullmq tables live in their own "bullmq" schema; migrate is advisory-locked across processes
  { connection: { connectionString: databaseUrl, migrate: true } },
  createPostgresBackend,
)

worker.on('failed', (job, err) => console.error(`job ${job?.id} failed`, err))
worker.on('error', (err) => console.error('worker error', err))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // close() can wait forever if the database is unreachable
    // shortcut: 10s also cuts off active jobs, revisit when pi runs need graceful cancel
    setTimeout(() => process.exit(1), 10_000).unref()
    await worker.close()
    process.exit(0)
  })
}

// the pg backend doesn't emit 'error' on connect failure, so fail fast instead of idling silently
await worker.waitUntilReady()
console.log('worker listening on queue agent-runs')
