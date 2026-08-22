import { getLink } from '@repo/data-ops/queries/links';
import { linkSchema, LinkSchemaType } from '@repo/data-ops/zod-schema/links';
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
