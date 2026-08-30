import { DurableObject } from 'cloudflare:workers';
import moment from 'moment';

interface ClickData {
	accountId: string;
	linkId: string;
	destinationUrl: string;
	destinationCountryCode: string;
}

export class EvaluationScheduler extends DurableObject<Env> {
	clickData: ClickData | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.clickData = await ctx.storage.get<ClickData>('click_data');
		});
	}

	async collectLinkClick(linkId: string, accountId: string, destinationUrl: string, destinationCountryCode: string) {
		this.clickData = {
			linkId,
			accountId,
			destinationCountryCode,
			destinationUrl,
		};

		await this.ctx.storage.put('click_data', this.clickData);

		const alarm = await this.ctx.storage.getAlarm();
		if (!alarm) {
			const oneDay = moment().add(24, 'hours').valueOf();
			await this.ctx.storage.setAlarm(oneDay);
		}
	}

	async alarm() {
		console.log('Evaluation scheduler alarm triggered');
		const clickData = this.clickData;
		if (!clickData) throw new Error('click data is not set');
		await this.env.DESTINATION_EVALUATION_WORKFLOW.create({
			params: {
				linkId: clickData?.linkId,
				destinationUrl: clickData?.destinationUrl,
				accountId: clickData?.accountId,
			},
		});
	}
}
