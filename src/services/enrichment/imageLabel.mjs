import classifier from '../../lib/images/imageClassifier.cjs';
import { imageStage } from './imageStage.mjs';

export function createImageLabelService(deps) {
  const model = process.env.IMAGE_LABEL_MODEL || 'gpt-5.6-terra';
  return imageStage('label', { ...deps, configured: deps.configured ?? (() => Boolean(process.env.OPENAI_API_KEY)),
    processImage: async (row, { signal }) => {
      const result = await (deps.classify ?? classifier.classify)(model, row.imageUrl, { signal, maxAttempts: 2 });
      if (result.error || !classifier.LABELS.includes(result.classification) || typeof result.description !== 'string'
        || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) throw new Error('invalid_image_label');
      return { classification: result.classification, description: result.description, confidence: result.confidence, model };
    } });
}
