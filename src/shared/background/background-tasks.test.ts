// Unit tests for work that runs after the response (e.g. emailing a password-reset code).
import { describe, expect, test, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createBackgroundTasks } from './background-tasks.js';

const logger = () => ({ error: vi.fn() }) as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> };

describe('createBackgroundTasks', () => {
  test('run() returns at once; settled() waits for the task', async () => {
    const tasks = createBackgroundTasks(logger());
    let isDone = false;
    tasks.run('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      isDone = true;
    });
    expect(isDone).toBe(false);
    await tasks.settled();
    expect(isDone).toBe(true);
  });

  test('a failure is logged under its name, never thrown', async () => {
    const log = logger();
    const tasks = createBackgroundTasks(log);
    tasks.run('mail', async () => {
      throw new Error('SMTP down');
    });
    await expect(tasks.settled()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ task: 'mail' }), 'background task failed');
  });

  test('settled() also waits for tasks started while it waits', async () => {
    const tasks = createBackgroundTasks(logger());
    const order: string[] = [];
    tasks.run('first', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      tasks.run('second', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push('second');
      });
      order.push('first');
    });
    await tasks.settled();
    expect(order).toEqual(['first', 'second']);
  });
});
