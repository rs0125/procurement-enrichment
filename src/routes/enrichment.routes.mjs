import { Router } from 'express';

export function enrichmentRoutes({services,authorize}) {
  const router=Router();
  router.use(authorize);
  router.get('/',(_req,res)=>res.json({services:services.list()}));
  router.post('/:service',async(req,res)=>{
    const controller=new AbortController();
    const abort=()=>{if(!res.writableEnded) controller.abort();};
    res.on('close',abort);
    try {
      if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) || Object.hasOwn(req.body,'signal')) {
        return res.status(400).json({error:'invalid_enrichment_input'});
      }
      const result=await services.run(req.params.service,{...req.body,signal:controller.signal});
      if(!controller.signal.aborted) res.status(result.status==='QUEUED'?202:200).json(result);
    } catch(error) {
      if(!controller.signal.aborted) res.status([400,404,503].includes(error.statusCode)?error.statusCode:500)
        .json({error:error.statusCode===400?'invalid_enrichment_input':error.statusCode===404?'unknown_enrichment_service':error.statusCode===503?'service_not_configured':'enrichment_failed'});
    } finally {res.off('close',abort);}
  });
  return router;
}
