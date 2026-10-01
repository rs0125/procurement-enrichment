import { request } from '../../lib/queue/contract.mjs';
import { GEOCODE_ELIGIBILITY_SQL } from '../../models/geocode/eligibility.mjs';
import { imageReadiness } from './planner.mjs';

class ReceiptExpired extends Error {}
function requireOwnership(value) {if(value!==true) throw new ReceiptExpired();}

export function createWarehouseRefresh({queue}) {
  return async(input,delivery)=>{
    let warehouse;
    try {
      const result=await queue.withReceipt(delivery.receipt,{signal:delivery.signal,
        lockSource:async client=>{
          warehouse=(await client.query('SELECT id FROM public."Warehouse" WHERE id=$1 FOR UPDATE',[input.subjectId])).rows[0];
          // A deleted warehouse still needs its event acknowledged.
          return true;
        },write:async client=>{
          const params=[delivery.receipt.msg_id,delivery.receipt.read_ct];
          if(!warehouse) {requireOwnership((await client.query('SELECT enrichment.finish($1,$2) AS owned',params)).rows[0].owned);return 'completed';}
          await client.query(`INSERT INTO public.labeled_warehouse_images ("warehouseId","imageUrl","labelStatus","webpStatus")
            SELECT min(w.id),u.url,'PENDING','PENDING' FROM public."Warehouse" w CROSS JOIN LATERAL
            unnest(public.wareongo_image_urls(w.media::jsonb,w.photos)) u(url) WHERE w.id=$1 GROUP BY u.url
            ON CONFLICT ("imageUrl") DO UPDATE SET "unreferencedAt"=NULL WHERE labeled_warehouse_images."unreferencedAt" IS NOT NULL`,[input.subjectId]);
          const cursor=(await client.query('SELECT enrichment.page_cursor($1,$2) AS cursor',params)).rows[0].cursor;
          if(cursor===null) throw new ReceiptExpired();
          const {rows}=await client.query(`SELECT l.* FROM public.labeled_warehouse_images l JOIN public."Warehouse" w
            ON l."imageUrl"=ANY(public.wareongo_image_urls(w.media::jsonb,w.photos))
            WHERE w.id=$1 AND l.id>$2 ORDER BY l.id LIMIT 11`,[input.subjectId,cursor]);
          const children=[];
          for(const row of rows.slice(0,10)) for(const action of ['image-label','website-approval','webp','document-kind']) {
            if(['eligible','waiting'].includes(imageReadiness(action,row).state)) children.push(request(action,row.id,input.lane));
          }
          if(cursor===0) {
            const {rows:[w]}=await client.query(`SELECT d.latitude,d.longitude,(${GEOCODE_ELIGIBILITY_SQL}) AS eligible FROM public."Warehouse" w
              LEFT JOIN public."WarehouseData" d ON d."warehouseId"=w.id LEFT JOIN public."GeocodeAttempt" a ON a."warehouseId"=w.id WHERE w.id=$1`,[input.subjectId]);
            if(w.eligible) children.push(request('geocode',input.subjectId,input.lane));
            if(w.latitude!=null && w.longitude!=null) children.push(request('proximity',input.subjectId,input.lane));
          }
          if(rows.length>10) {
            requireOwnership((await client.query('SELECT enrichment.advance_page($1,$2,$3,$4::jsonb) AS owned',[...params,rows[9].id,JSON.stringify(children)])).rows[0].owned);
            return 'deferred';
          }
          requireOwnership((await client.query('SELECT enrichment.finish($1,$2,$3::jsonb) AS owned',[...params,JSON.stringify(children)])).rows[0].owned);
          return 'completed';
        }});
      return {kind:'settled',state:result.published?result.value:'stale'};
    } catch(error) {
      if(error instanceof ReceiptExpired) return {kind:'settled',state:'stale'};
      throw error;
    }
  };
}
