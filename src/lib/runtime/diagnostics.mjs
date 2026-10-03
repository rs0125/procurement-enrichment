// Never serialize exception messages, stacks, URLs, provider bodies or arbitrary
// properties. Only recognized machine codes and our own correlation fields leave
// the catch boundary. Wrapped operations retain this safe context, not the error.
const codes = new Set(['57014','55P03','40P01','40001','53300','53400','08000','08001','08003','08004','08006','08007','08P01',
  '23502','23503','23505','23514','22P02','22003','42501','42P01','42703','57P01','57P02','57P03',
  'ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','EPIPE','ENOSPC','ENOMEM',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ABORT_ERR',
  'P1001','P1002','P1008','P1017','P2002','P2003','P2010','P2024','P2028','P2034',
  'invalid_queue_input','queue_setup_required']);
const identifiers = new Set(['jobId','parentJobId','subjectId','messageId']);
class OperationFailure extends Error {
  constructor(details) {
    super('Enrichment operation failed');this.details=Object.freeze(details);
    if(details.httpStatus) this.statusCode=details.httpStatus;
  }
}
function contextFields(context) {
  const out={};
  for(const [key,value] of Object.entries(context??{})) {
    if(identifiers.has(key) && /^(?:0|[1-9][0-9]{0,18})$/.test(String(value))) out[key]=String(value);
    else if(['jobName','action','operation'].includes(key) && typeof value==='string' && /^[a-z][a-z0-9_:-]{0,79}$/.test(value)) out[key]=value;
    else if(key==='readCount' && Number.isSafeInteger(value) && value>0) out[key]=value;
  }
  return out;
}
export function diagnostic(error,context={}) {
  if(error instanceof OperationFailure) return {...contextFields(context),...error.details};
  const out={...contextFields(context),code:'unknown_error'};
  let current=error;
  for(let depth=0;current && depth<4;depth++,current=current.cause) {
    if(codes.has(current.code)) {
      if(out.code==='unknown_error') out.code=current.code;
      else if(current.code!==out.code) out.causeCode=current.code;
    }
    if(codes.has(current.meta?.code)) out.databaseCode=current.meta.code;
    const status=current.statusCode ?? current.status ?? current.response?.status ?? current.$metadata?.httpStatusCode;
    if(Number.isInteger(status) && status>=400 && status<=599) out.httpStatus=status;
    if(out.code==='unknown_error' && ['AbortError','TimeoutError'].includes(current.name)) out.code=current.name==='AbortError'?'aborted':'timeout';
  }
  return out;
}
export async function operation(context,work) {
  try { return await work(); } catch(error) { throw new OperationFailure(diagnostic(error,context)); }
}
export function reportDiagnostic(error,context={}) {
  const details=diagnostic(error,context);
  console.error(JSON.stringify({event:'enrichment_error',...details}));
  return details;
}
