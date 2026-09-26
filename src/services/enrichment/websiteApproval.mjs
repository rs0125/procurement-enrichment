import assessment from '../../lib/images/websiteImageAssessment.cjs';
import { imageStage } from './imageStage.mjs';

export function createWebsiteApprovalService(deps) {
  return imageStage('website', { ...deps, configured: deps.configured ?? (() => Boolean(process.env.OPENAI_API_KEY)),
    processImage: (row, { signal }) => (deps.assess ?? assessment.assessWebsiteImage)(row.imageUrl, { signal, preferUrl: true }) });
}
