import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';
import { collectDestinationInfo } from '@/helpers/browser-render';
import { aiDestinationChecker } from '@/helpers/ai-destination-checker';
import { addEvaluation } from '@repo/data-ops/queries/evaluations';
import { initDatabase } from '@repo/data-ops/database';
export class DestinationEvaluationWorkflow extends WorkflowEntrypoint<Env, unknown> {
	async run(event: Readonly<WorkflowEvent<DestinationStatusEvaluationParams>>, step: WorkflowStep) {
		initDatabase(this.env.DB);
		const collectedData = await step.do('Collect rendered destination page data', async () => {
			return collectDestinationInfo(this.env, event.payload.destinationUrl);
		});
		const aiStatus = await step.do(
			'Use AI to check status of page',
			{
				retries: {
					limit: 0,
					delay: 0,
				},
			},
			async () => {
				return await aiDestinationChecker(this.env, collectedData.bodyText);
			},
		);
		const evaluationId = await step.do('Save evaluation in Database', async () => {
			return await addEvaluation({
				linkId: event.payload.linkId,
				status: aiStatus.status,
				reason: aiStatus.statusReason,
				accountId: event.payload.accountId,
				destinationUrl: event.payload.destinationUrl,
			});
		});
		await step.do('Backup destination HTML in R2', async () => {
			const accountId = event.payload.accountId;
			const r2PathHTML = `evaluations/${accountId}/html/${evaluationId}`;
			const r2PathBodyText = `evaluations/${accountId}/body-text/${evaluationId}`;
			const r2PathScreenshot = `evaluations/${accountId}/screenshots/${evaluationId}.png`;

			//Convert base64 data url to Buffer for R2 storage
			const screenshotBase64 = collectedData.screenshotDataUrl.replace(/^data:image\/png;base64,/, '');
			const screenshotBUffer = Buffer.from(screenshotBase64, 'base64');

			await this.env.BUCKET.put(r2PathHTML, collectedData.html);
			await this.env.BUCKET.put(r2PathBodyText, collectedData.bodyText);
			await this.env.BUCKET.put(r2PathScreenshot, screenshotBUffer);
		});
	}
}
