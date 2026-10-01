import { createQueueConsumer } from './consumer.mjs';
import { createQueueDispatcher } from './dispatcher.mjs';
import { createWarehouseRefresh } from './refresh.mjs';

export function createQueueRuntime({queue,prisma,services,settings,execute,
  heartbeatMs=10000,schedule=setInterval,unschedule=clearInterval}) {
  const consumer=createQueueConsumer({queue,settings,execute,
    dispatch:createQueueDispatcher({prisma,services,refresh:createWarehouseRefresh({queue})})});
  let leader,backendPid,loop,startup,heartbeat,timer,stopped=false,failed=false,onFailure=()=>{};
  const stop=()=>{stopped=true;if(timer) unschedule(timer);timer=null;consumer.stop();};
  const release=()=>{if(leader) {leader.removeListener('error',fail);leader.release(true);leader=null;}};
  const fail=()=>{if(failed || stopped)return;failed=true;stop();services.stop();onFailure();};
  async function checkLeader() {
    try {
      const {rows:[row]}=await leader.query({text:`SELECT pg_backend_pid() AS pid,EXISTS(
        SELECT FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
          AND classid=19870430 AND objid=2 AND objsubid=2 AND granted) AS held`,query_timeout:10000});
      if(!row.held || row.pid!==backendPid) throw new Error('Leadership lost');
    } catch {fail();}
  }
  async function startWorker() {
    try {
      const connection=queue.pool.options?.connectionString;
      if(connection) {
        const url=new URL(connection);
        if(url.port==='6543' || url.searchParams.get('pgbouncer')==='true') throw new Error('Queue worker requires direct or session-mode PostgreSQL');
      }
      await queue.assertReady();
      if(stopped) return;
      leader=await queue.pool.connect();leader.on('error',fail);
      // Bound abandoned session locks on the server, including silent network loss.
      await leader.query("SET idle_session_timeout='45s'");
      const {rows:[row]}=await leader.query('SELECT pg_backend_pid() AS pid,pg_try_advisory_lock(19870430,2) AS held');
      if(!row.held) throw new Error('Queue worker already active');
      backendPid=row.pid;
      if(stopped) return;
      timer=schedule(()=>{if(!heartbeat) heartbeat=checkLeader().finally(()=>{heartbeat=null;});},heartbeatMs);
      timer.unref?.();
      loop=consumer.start();loop?.catch(fail);
    } catch(error) {failed=true;stop();release();throw error;}
  }
  return {
    onFailure(handler) {onFailure=handler;},
    start() {
      if(!settings.canConsume || stopped) return Promise.resolve();
      return startup??=startWorker();
    },
    stop,
    async drain() {
      stop();
      try {
        await startup?.catch(()=>{});
        await Promise.allSettled([loop,heartbeat,consumer.drain()]);
      } finally {release();}
    },
    status:()=>{const state=consumer.status();return {...state,mode:settings.mode,role:settings.role,healthy:!failed && state.healthy};}
  };
}
