import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('transaction network loss cannot crash the worker or commit partial writes',
  {skip:!process.env.ENRICHER_TEST_DATABASE_URL,timeout:35000},async()=>{
    const {stdout}=await promisify(execFile)(process.execPath,
      ['--unhandled-rejections=strict','--experimental-strip-types',fileURLToPath(new URL('./fixtures/transactionDisconnect.mjs',import.meta.url))],
      {env:process.env,timeout:30000,maxBuffer:1024*1024});
    assert.match(stdout,/rollback and next transaction verified/);
  });
