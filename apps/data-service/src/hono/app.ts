import { captureLinkClickInBackground, getDestinationsForCountry, getRoutingDestinations } from '@/helpers/routing-ops';
import { cloudflareInfoSchema } from '@repo/data-ops/zod-schema/links';
import { LinkClickMessageType } from '@repo/data-ops/zod-schema/queue';
import { Hono } from 'hono';

export const App = new Hono<{ Bindings: Env }>();

App.get('/link-click/:accountId', async (c) => {
	const accountId = c.req.param('accountId');
	const doId = c.env.LINK_CLICK_TRACKER_OBJECT.idFromName(accountId);
	const stub = c.env.LINK_CLICK_TRACKER_OBJECT.get(doId);
	return await stub.fetch(c.req.raw);
});

App.get('/:id', async (c) => {
	const linkId = c.req.param('id');
	const linkInfo = await getRoutingDestinations(c.env, linkId);

	if (!linkInfo) {
		return c.text('Destination Not Found', 404);
	}

	const cfHeader = cloudflareInfoSchema.safeParse(c.req.raw.cf);
	if (!cfHeader.success) {
		return c.text('Invalid Cloudflare Headers', 400);
	}

	const headers = cfHeader.data;
	const destination = getDestinationsForCountry(linkInfo, headers.country);
	const queueMessage: LinkClickMessageType = {
		type: 'LINK_CLICK',
		data: {
			id: linkId,
			country: headers.country,
			destination: destination,
			accountId: linkInfo.accountId,
			latitude: headers.latitude,
			longitude: headers.longitude,
			timestamp: new Date().toISOString(),
		},
	};

	c.executionCtx.waitUntil(captureLinkClickInBackground(c.env, queueMessage));

	return c.redirect(destination);
});
