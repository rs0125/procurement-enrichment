import classifier from '../../lib/images/imageClassifier.cjs';
import { imageStage } from './imageStage.mjs';

export function createDocumentKindService(deps) {
  const model = process.env.IMAGE_LABEL_MODEL || 'gpt-5.6-terra';
  return imageStage('document', { ...deps, configured: deps.configured ?? (() => Boolean(process.env.OPENAI_API_KEY)),
    processImage: async (row, { signal }) => {
      const result = await (deps.classify ?? classifier.classifyDocumentKind)(model, row.imageUrl, { signal, maxAttempts: 2 });
      if (result.error || !classifier.DOC_KINDS.includes(result.documentKind)) throw new Error('invalid_document_kind');
      return { documentKind: result.documentKind };
    } });
}
