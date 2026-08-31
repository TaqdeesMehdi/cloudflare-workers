import { getLink } from '@repo/data-ops/queries/links';
import { linkSchema, LinkSchemaType } from '@repo/data-ops/zod-schema/links';
import { LinkClickMessageType } from '@repo/data-ops/zod-schema/queue';
import moment from 'moment';

const TTL_TIME = 60 * 60 * 24;

async function getLinkInfoFromKv(env: Env, id: string) {
	const linkInfo = await env.CACHE.get(id);
	if (!linkInfo) return null;
	try {
		const parsedLinkinfo = JSON.parse(linkInfo);
		return linkSchema.parse(parsedLinkinfo);
	} catch (error) {
		return null;
	}
}

async function saveLinkInfoToKv(env: Env, id: string, linkInfo: LinkSchemaType) {
	try {
		await env.CACHE.put(id, JSON.stringify(linkInfo), {
			expirationTtl: TTL_TIME,
		});
	} catch (error) {
		console.error('Error while saving LinkInfo to KV', error);
	}
}

export async function getRoutingDestinations(env: Env, id: string) {
	const linkInfo = await getLinkInfoFromKv(env, id);
	if (linkInfo) return linkInfo;
	const linkInfoFromDB = await getLink(id);
	if (!linkInfoFromDB) return null;
	await saveLinkInfoToKv(env, id, linkInfoFromDB);
	return linkInfoFromDB;
}

export function getDestinationsForCountry(linkInfo: LinkSchemaType, countryCode?: string) {
	if (!countryCode) {
		return linkInfo.destinations.default;
	}
	if (linkInfo.destinations[countryCode]) {
		return linkInfo.destinations[countryCode];
	}
	return linkInfo.destinations.default;
}

export async function scheduleEvalWorkflow(env: Env, event: LinkClickMessageType) {
	const doId = env.EVALUATION_SCHEDULER.idFromName(`${event.data.id}:${event.data.destination}`);
	const stub = env.EVALUATION_SCHEDULER.get(doId);
	await stub.collectLinkClick(event.data.accountId, event.data.id, event.data.destination, event.data.country || 'UNKNOWN');
}

export async function captureLinkClickInBackground(env: Env, event: LinkClickMessageType) {
	await env.QUEUE.send(event);
	const doId = env.LINK_CLICK_TRACKER_OBJECT.idFromName(event.data.accountId);
	const stub = env.LINK_CLICK_TRACKER_OBJECT.get(doId);
	if (!event.data.latitude || !event.data.longitude || !event.data.country) return;
	await stub.addClick(event.data.latitude, event.data.longitude, event.data.country, moment().valueOf());
}
