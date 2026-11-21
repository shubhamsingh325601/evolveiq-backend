// Work that runs after the response has gone, such as emailing a password-reset code: the reply
// must neither wait for it nor reveal, by its timing, whether there was anything to do.
// A failure is logged, never thrown at a client. app.close() waits for whatever is still running
// (graceful shutdown), and tests wait the same way (`app.backgroundTasks.settled()`).
import type { FastifyBaseLogger } from 'fastify';

export interface BackgroundTasks {
  /** Starts `task` without waiting for it. A failure is logged under `name`. */
  run(name: string, task: () => Promise<void>): void;
  /** Resolves once every task started so far, and any they started, has finished. */
  settled(): Promise<void>;
}

export function createBackgroundTasks(log: FastifyBaseLogger): BackgroundTasks {
  const pending = new Set<Promise<void>>();
  return {
    run(name, task) {
      const running: Promise<void> = Promise.resolve()
        .then(task)
        .catch((err: unknown) => {
          log.error({ err, task: name }, 'background task failed');
        })
        .finally(() => {
          pending.delete(running);
        });
      pending.add(running);
    },
    async settled() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
