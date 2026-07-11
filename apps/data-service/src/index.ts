import { WorkerEntrypoint } from 'cloudflare:workers';

export default class DataService extends WorkerEntrypoint<Env> {
	fetch(request: Request) {
		return new Response('Hello World!');
	}
}
