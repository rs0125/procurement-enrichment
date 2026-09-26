const sharp = require('sharp');
const fs = require('node:fs/promises');
sharp.cache(false); sharp.concurrency(1);
const [input, output, format, rawEdge] = process.argv.slice(2);
(async () => {
  const edge = Number(rawEdge);
  if (!['inspect','jpeg','webp'].includes(format) || ![1280,1920].includes(edge)) throw new Error('source_invalid_options');
  const options = { limitInputPixels: 16000000, sequentialRead: true, failOn: 'error' };
  const m = await sharp(input, options).metadata();
  if ((m.pages || 1) > 1) throw new Error('source_animated_or_multipage');
  const metadata = { format:m.format,width:m.width,height:m.height,orientation:m.orientation,space:m.space,pages:m.pages };
  const bytes = (await fs.stat(input)).size;
  if (format === 'inspect') {
    if (m.format === 'jpeg' && m.width <= edge && m.height <= edge && (!m.orientation || m.orientation === 1)
      && ['srgb','b-w'].includes(m.space)) await sharp(input, options).timeout({seconds:15}).stats();
    console.log(JSON.stringify({ok:true,bytes,metadata})); return;
  }
  let pipeline = sharp(input, options).timeout({seconds:15}).rotate()
    .resize({width:edge,height:edge,fit:'inside',withoutEnlargement:true});
  pipeline = format === 'jpeg' ? pipeline.flatten({background:'#fff'}).jpeg({quality:82,progressive:true,chromaSubsampling:'4:2:0'})
    : pipeline.webp({quality:75});
  const info = await pipeline.toFile(output);
  const check = await sharp(output).metadata();
  if (check.format !== format || !info.size || info.width > edge || info.height > edge
    || (check.orientation && check.orientation !== 1)) throw new Error('source_invalid_output');
  console.log(JSON.stringify({ok:true,bytes:info.size,width:info.width,height:info.height,metadata,
    peakRssMiB:Math.ceil(process.resourceUsage().maxRSS/1024)}));
})().catch(error => {
  const reason = /^source_[a-z_]+$/.test(error.message) ? error.message
    : /pixel limit/i.test(error.message) ? 'source_too_many_pixels' : 'source_decode_failed';
  console.log(JSON.stringify({ok:false,reason})); process.exitCode=1;
});
