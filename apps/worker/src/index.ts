import { Worker } from 'bullmq'
import { Redis } from 'ioredis'

const redisUrl = process.env.REDIS_URL
if (!redisUrl) throw new Error('REDIS_URL is not set')

const worker = new Worker(
  'agent-runs',
  async (job) => {
    // TODO: spawn pi in RPC mode and stream events into the db
    console.log(`job ${job.id}`, job.data)
  },
  // bullmq 6 needs a client instance under ESM; Workers require maxRetriesPerRequest: null
  { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) },
)

worker.on('failed', (job, err) => console.error(`job ${job?.id} failed`, err))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // close() waits forever if redis is unreachable
    // shortcut: 10s also cuts off active jobs, revisit when pi runs need graceful cancel
    setTimeout(() => process.exit(1), 10_000).unref()
    await worker.close()
    process.exit(0)
  })
}

console.log('worker listening on queue agent-runs')
