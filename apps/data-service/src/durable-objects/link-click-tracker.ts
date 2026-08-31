import { DurableObject } from 'cloudflare:workers';
import moment from 'moment';

export class LinkClickTracker extends DurableObject {
	sql: SqlStorage;
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.sql.exec(`
            CREATE TABLE IF NOT EXISTS geo_link_clicks (
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            country TEXT NOT NULL,
            time INTEGER NOT NULL
        )
            
     `);
		});
	}

	async addClick(longitude: number, latitude: number, country: string, time: number) {
		this.sql.exec(
			`
            INSERT INTO geo_link_clicks (latitude, longitude, country, time)
            VALUES(?, ?, ?, ?)
            `,
			latitude,
			longitude,
			country,
			time,
		);
	}

	async fetch(_: Request) {
		const query = `
        SELECT * FROM geo_link_clicks
        limit 100
        `;

		const cursor = this.sql.exec(query);
		const result = cursor.toArray();

		return new Response(
			JSON.stringify({
				clicks: result,
			}),
			{
				headers: {
					'Content-Type': 'application/json',
				},
			},
		);
	}
}
