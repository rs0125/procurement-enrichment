import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, readFile, mkdir, mkdtemp, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_BYTES = 20 * 1024 * 1024;
export function validateSource(value, publicBase) {
  const source = new URL(value), base = new URL(publicBase);
  if (source.protocol !== 'https:' || source.origin !== base.origin || source.username || source.password) {
    const error = new Error('unsupported_source_host'); error.unsupported = true; throw error;
  }
  return source.href;
}
export async function download(source, file, publicBase, signal, http = fetch) {
  validateSource(source, publicBase);
  const response = await http(source, { redirect:'error', signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel(); throw new Error('source_download_failed');
  }
  const handle = await open(file, 'wx', 0o600), hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error('source_too_large');
      signal.throwIfAborted(); hash.update(chunk); await handle.writeFile(chunk);
    }
    if (!bytes) throw new Error('source_empty');
    return { bytes, hash:hash.digest('hex') };
  } finally { await handle.close(); }
}

export async function withTemporaryFiles(work, root = process.env.ENRICHER_TEMP_DIR || '/var/tmp/warehouse-enricher', { diskInfo = statfs } = {}) {
  await mkdir(root, {recursive:true,mode:0o700});
  const disk = await diskInfo(root);
  if (disk.type === 0x01021994 || disk.bavail * disk.bsize < 256 * 1024 * 1024) {
    const error = new Error('disk_buffer_unavailable'); error.code = 'memory_pressure'; throw error;
  }
  const dir = await mkdtemp(join(root, 'image-'));
  try { return await work(join(dir,'source'),join(dir,'output')); }
  finally { await rm(dir,{recursive:true,force:true}); }
}

export function decode(input, output, format, edge, signal) {
  return new Promise((resolve,reject) => {
    const child=spawn(process.execPath,['--max-old-space-size=64',fileURLToPath(new URL('./decoderWorker.cjs',import.meta.url)),input,output,format,String(edge)],{
      stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,LANG:'C.UTF-8',UV_THREADPOOL_SIZE:'1',MALLOC_ARENA_MAX:'2'} });
    let text='', failure, closed=false, checking=false;
    const stop=error=>{ if (!closed) {failure ||= error; child.kill('SIGKILL');} };
    const abort=()=>stop(new Error('processing_aborted'));
    signal.addEventListener('abort',abort,{once:true}); if(signal.aborted) abort();
    const timeout=setTimeout(()=>stop(new Error('source_decode_timeout')),30000);
    const monitor=setInterval(async()=>{
      if(closed || checking || !child.pid) return;
      checking=true;
      try {
        const status=await readFile(`/proc/${child.pid}/status`,'utf8');
        if(Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0)>256*1024) stop(new Error('source_decoder_memory_limit'));
      } catch(error) { if(error.code!=='ENOENT') stop(new Error('source_memory_check_failed')); }
      finally { checking=false; }
    },100);
    child.stdout.on('data',chunk=>{ text+=chunk; if(text.length>4096) stop(new Error('source_decoder_invalid_response')); });
    child.on('error',()=>{failure ||= new Error('source_decoder_start_failed');});
    child.on('close',code=>{
      closed=true; clearTimeout(timeout);clearInterval(monitor);signal.removeEventListener('abort',abort);
      if(failure) return reject(failure);
      let result;try{result=JSON.parse(text);}catch{}
      if(code===0 && result?.ok) return resolve(result);
      const error=new Error('source_decode_failed');
      error.unsupported=['source_too_many_pixels','source_animated_or_multipage'].includes(result?.reason);
      reject(error);
    });
  });
}
