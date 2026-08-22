import { addLinkClicks } from '@repo/data-ops/queries/links';
import { LinkClickMessageType } from '@repo/data-ops/zod-schema/queue';

export async function handleLinkClick(env: Env, event: LinkClickMessageType) {
	await addLinkClicks(event.data);
}
