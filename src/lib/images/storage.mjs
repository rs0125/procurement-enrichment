import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const required=['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET_NAME','R2_PUBLIC_URL'];
export const storageConfigured=(env=process.env)=>required.every(key=>env[key]?.trim());
export function createStorage(env=process.env,{client}={}) {
  if(!storageConfigured(env)) throw new Error('storage_configuration_missing');
  const base=new URL(env.R2_PUBLIC_URL);
  if(base.protocol!=='https:' || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw new Error('invalid_public_base');
  const bucket=env.R2_BUCKET_NAME.trim();
  const s3=client ?? new S3Client({region:'auto',endpoint:`https://${env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`,
    credentials:{accessKeyId:env.R2_ACCESS_KEY_ID.trim(),secretAccessKey:env.R2_SECRET_ACCESS_KEY.trim()},maxAttempts:2});
  return {publicBase:base.origin,bucket,
    url:key=>`${base.origin}/${key.split('/').map(encodeURIComponent).join('/')}`,
    async head(key,signal) {
      try {
        const value=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
        return value.ContentLength>0 ? {bytes:value.ContentLength,modifiedAt:value.LastModified || new Date()} : null;
      } catch(error) {if(error?.$metadata?.httpStatusCode===404 || error?.name==='NotFound') return null; throw error;}
    },
    async put(key,file,format,signal) {
      if(!key.startsWith(`${format}/images/`)) throw new Error('invalid_variant_key');
      const bytes=(await stat(file)).size;
      if(!bytes || bytes>20*1024*1024) throw new Error('invalid_variant_size');
      const body=createReadStream(file);
      try {
        await s3.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,ContentLength:bytes,
          ContentType:`image/${format}`,CacheControl:'public, max-age=31536000, immutable',IfNoneMatch:'*'}),
          {abortSignal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
        return {bytes,modifiedAt:new Date()};
      } catch(error) {
        if(error?.$metadata?.httpStatusCode!==412) throw error;
        const existing=await this.head(key,signal); if(!existing) throw error; return existing;
      } finally {body.destroy();}
    }
  };
}
