import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { decode,download,validateSource,withTemporaryFiles,MAX_BYTES } from '../src/lib/images/files.mjs';

test('isolated encoders apply photo/document sizes and explicit formats',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'enricher-encode-'));
  try {
    const input=join(dir,'source.png');
    await sharp({create:{width:2100,height:1400,channels:4,background:{r:100,g:150,b:180,alpha:.5}}}).png().toFile(input);
    for(const [format,edge] of [['jpeg',1280],['jpeg',1920],['webp',1280]]) {
      const output=join(dir,`${format}-${edge}`);
      const result=await decode(input,output,format,edge,new AbortController().signal);
      const actual=await sharp(output).metadata();
      assert.equal(actual.format,format);assert.equal(actual.width,edge);assert.ok(actual.height<=edge);assert.ok(result.bytes>0);
      if(format==='jpeg') {assert.equal(actual.isProgressive,true);assert.equal(actual.hasAlpha,false);}
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('decoder cancellation kills the child before reporting completion',async()=>{
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(decode('/missing','/missing','jpeg',1280,aborted.signal),/processing_aborted/);
});
test('source download enforces size even without a Content-Length',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'enricher-download-'));
  try {
    const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_BYTES+1));controller.close();}});
    await assert.rejects(download('https://images.example/x.jpg',join(dir,'source'),'https://images.example',new AbortController().signal,
      async()=>new Response(stream)),/source_too_large/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('compression restricts downloads to the configured original bucket',()=>{
  assert.throws(()=>validateSource('http://127.0.0.1/test','https://images.example'));
  assert.throws(()=>validateSource('https://other.example/test','https://images.example'));
  assert.equal(validateSource('https://images.example/x.jpg','https://images.example'),'https://images.example/x.jpg');
});
test('temporary files are cleaned after failures',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'enricher-cleanup-'));let file;
  try {
    await assert.rejects(withTemporaryFiles(async input=>{file=input;throw new Error('test_failure');},dir,
      {diskInfo:async()=>({type:0,bavail:1024,bsize:1024*1024})}),/test_failure/);
    await assert.rejects(readFile(file),{code:'ENOENT'});
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('production image buffers reject tmpfs and low disk space',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'enricher-disk-'));
  try {
    for(const info of [{type:0x01021994,bavail:1024,bsize:1024*1024},{type:0,bavail:1,bsize:1024}]) {
      await assert.rejects(withTemporaryFiles(()=>assert.fail('image work started'),dir,{diskInfo:async()=>info}),/disk_buffer_unavailable/);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
