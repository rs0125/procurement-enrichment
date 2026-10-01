import { readFile } from 'node:fs/promises';

const MiB = 1024 * 1024;
export async function memoryAvailable({ read = readFile } = {}) {
  const info = await read('/proc/meminfo', 'utf8');
  const host = Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] || 0) * 1024;
  let available = host;
  try {
    const group = (await read('/proc/self/cgroup', 'utf8')).split('\n').find(s => s.startsWith('0::'))?.slice(3);
    const roots = ['/sys/fs/cgroup', ...(group && group !== '/' ? ['/sys/fs/cgroup' + group] : [])];
    for (const root of roots) {
      try {
        const [limit, used] = await Promise.all([read(root + '/memory.max', 'utf8'), read(root + '/memory.current', 'utf8')]);
        if (limit.trim() !== 'max') available = Math.min(available, Number(limit) - Number(used));
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return available;
}

export function createExecutor({ available = memoryAvailable, rss = () => process.memoryUsage().rss,
  onMemoryLimit = () => {} } = {}) {
  let active = false, recycling = false;
  return async work => {
    if (active) return { status: 'DEFERRED', reason: 'worker_busy' };
    if (recycling) return { status: 'DEFERRED', reason: 'memory_pressure' };
    active = true;
    try {
      // Native image allocations can keep RSS high even after the action ends.
      // Stop admitting work and let the supervised process drain and restart.
      // Host/cgroup pressure alone must not cause a restart loop.
      if (rss() > 384 * MiB) {
        recycling = true;
        onMemoryLimit();
        return { status: 'DEFERRED', reason: 'memory_pressure' };
      }
      if (await available() < 384 * MiB) return { status: 'DEFERRED', reason: 'memory_pressure' };
      return await work();
    } finally { active = false; }
  };
}

export function positiveId(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    const error = new Error('A positive integer ID is required'); error.statusCode = 400; throw error;
  }
  return value;
}
