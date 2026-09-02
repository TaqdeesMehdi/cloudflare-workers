# Understanding This Codebase

A deep walkthrough of every Cloudflare primitive used here: **KV cache**, **Queues**, **Durable Objects**, **WebSockets**, **Workflows**, **Browser Rendering**, **Workers AI**, **R2**, and **D1** — plus how the frontend ties into all of it.

---

## Table of contents

1. [What the product actually does](#1-what-the-product-actually-does)
2. [Repo layout](#2-repo-layout)
3. [The two Workers and their bindings](#3-the-two-workers-and-their-bindings)
4. [The spine: life of one link click](#4-the-spine-life-of-one-link-click)
5. [KV cache — deep dive](#5-kv-cache--deep-dive)
6. [Queues — deep dive](#6-queues--deep-dive)
7. [Durable Objects — deep dive](#7-durable-objects--deep-dive)
8. [WebSockets — deep dive](#8-websockets--deep-dive)
9. [Workflows — deep dive](#9-workflows--deep-dive)
10. [Browser Rendering + Workers AI + R2](#10-browser-rendering--workers-ai--r2)
11. [D1 + Drizzle + the data-ops package](#11-d1--drizzle--the-data-ops-package)
12. [The frontend: tRPC, TanStack, zustand](#12-the-frontend-trpc-tanstack-zustand)
13. [Running it locally & deploying](#13-running-it-locally--deploying)
14. [Known bugs and rough edges](#14-known-bugs-and-rough-edges)
15. [Cheat sheet: which primitive, and why](#15-cheat-sheet-which-primitive-and-why)

---

## 1. What the product actually does

It's a **smart link shortener with analytics**.

- A user creates a link with a set of destination URLs: a `default` URL plus optional per-country overrides (`"US": ..., "DE": ...`).
- When someone hits `https://data-service.../<linkId>`, the edge worker looks at Cloudflare's geo headers, picks the right destination for that visitor's country, and **302 redirects** them.
- Every click is recorded three ways:
  1. **Durably**, into D1 (via a Queue, so the redirect isn't slowed down).
  2. **Live**, into a per-account Durable Object that pushes clicks over WebSocket to an open dashboard so a map animates in real time.
  3. **As a scheduling signal**, into a second Durable Object that — 24 hours later — kicks off an AI Workflow that renders the destination page in a headless browser and asks an LLM "is this product still in stock?"

So there are three timescales in one app: **instant** (redirect), **near-real-time** (2-second WebSocket flush), and **slow/durable** (24h evaluation workflow).

---

## 2. Repo layout

```
full-stack-on-cloudflare-starter-repo-main/
├── apps/
│   ├── data-service/         Worker #1 — the redirect + analytics engine
│   └── user-application/     Worker #2 — React SPA + tRPC API
└── packages/
    └── data-ops/             Shared library: Drizzle schema, queries, Zod schemas
```

pnpm workspace monorepo. `@repo/data-ops` is a **build-step package**: it compiles with `tsc` to `dist/`, and both Workers import from its `exports` map, not from source:

```jsonc
// packages/data-ops/package.json
"exports": {
  "./database":       "./dist/db/database.js",
  "./queries/*":      "./dist/queries/*.js",
  "./zod-schema/*":   "./dist/zod/*.js"
}
```

> **Practical consequence:** if you edit anything in `packages/data-ops/src`, you must run `pnpm build-package` (root script) before the Workers see the change. This is the #1 source of "why isn't my change showing up".

Key files:

| File | What it holds |
|---|---|
| [packages/data-ops/src/drizzle-out/schema.ts](packages/data-ops/src/drizzle-out/schema.ts) | D1 tables: `links`, `link_clicks`, `destination_evaluations` |
| [packages/data-ops/src/queries/links.ts](packages/data-ops/src/queries/links.ts) | All link CRUD + click insert |
| [packages/data-ops/src/zod/links.ts](packages/data-ops/src/zod/links.ts) | Runtime validation shared front↔back |
| [packages/data-ops/src/zod/queue.ts](packages/data-ops/src/zod/queue.ts) | The queue message contract |

---

## 3. The two Workers and their bindings

### `data-service` — the edge engine

Config: [apps/data-service/wrangler.jsonc](apps/data-service/wrangler.jsonc)

| Binding | Type | Used for |
|---|---|---|
| `CACHE` | KV namespace | Hot cache of link → destinations |
| `DB` | D1 | Source of truth (SQLite at the edge) |
| `QUEUE` | Queue producer | Fire-and-forget click ingestion |
| `BUCKET` | R2 | Archive of rendered HTML / screenshots |
| `AI` | Workers AI | LLM inference for page status |
| `VIRTUAL_BROWSER` | Browser Rendering | Headless Chrome |
| `EVALUATION_SCHEDULER` | Durable Object | 24h debounce timer per link+destination |
| `LINK_CLICK_TRACKER_OBJECT` | Durable Object (SQLite) | Live click buffer + WebSocket hub |
| `DESTINATION_EVALUATION_WORKFLOW` | Workflow | Durable multi-step evaluation job |

The entrypoint is a **class-based Worker**, not the classic `export default { fetch }`:

```ts
// apps/data-service/src/index.ts
export default class DataService extends WorkerEntrypoint<Env> {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, env);
    initDatabase(env.DB);          // wire Drizzle once per isolate
  }
  fetch(request: Request)  { return App.fetch(request, this.env, this.ctx); }  // → Hono
  async queue(batch: MessageBatch) { /* queue consumer */ }
}
```

Two handlers on one class:
- `fetch` → HTTP traffic, delegated to Hono ([app.ts](apps/data-service/src/hono/app.ts)).
- `queue` → invoked by Cloudflare when messages are ready. **Same Worker code, different trigger.** This is why the queue consumer has access to all the same bindings.

Note the re-exports at the top of that file:

```ts
export { DestinationEvaluationWorkflow } from '@/workflows/destination-evaluation-workflow';
export { EvaluationScheduler } from '@/durable-objects/evalutaion-scheduler';
export { LinkClickTracker } from '@/durable-objects/link-click-tracker';
```

Durable Object classes and Workflow classes **must be exported from the Worker's main module**. That's how the runtime finds `class_name: "LinkClickTracker"` from the wrangler config. Forget the export → deploy fails.

### `user-application` — the dashboard

Config: [apps/user-application/wrangler.jsonc](apps/user-application/wrangler.jsonc)

A plain Worker with two jobs ([worker/index.ts](apps/user-application/worker/index.ts)):

```ts
if (url.pathname.startsWith("/trpc")) {
  return fetchRequestHandler({ endpoint: "/trpc", req: request, router: appRouter, createContext: ... });
}
return env.ASSETS.fetch(request);   // static React build, SPA fallback
```

`assets.not_found_handling: "single-page-application"` means any unmatched path returns `index.html` so TanStack Router can handle client-side routing.

Both Workers point at **the same D1 database id** (`bd12a7eb-…`), so the dashboard reads exactly what the edge engine writes.

---

## 4. The spine: life of one link click

This single flow touches KV, Queues, D1, both DOs, WebSockets, and (eventually) the Workflow. Follow it once and the rest is detail.

```
Visitor
  │  GET https://data-service.../abc123
  ▼
┌──────────────────────────── Hono route  App.get('/:id') ────────────────────────────┐
│ 1. getRoutingDestinations(env, id)                                                  │
│      ├─ KV CACHE.get(id) ──── HIT ──► parse+validate, return                        │
│      └─ MISS ► D1 getLink(id) ► CACHE.put(id, json, ttl 24h) ► return               │
│ 2. Parse request.cf → { country, latitude, longitude }                              │
│ 3. destination = destinations[country] ?? destinations.default                       │
│ 4. Build LINK_CLICK queue message                                                    │
│ 5. ctx.waitUntil(captureLinkClickInBackground(...))   ← does NOT block the response  │
│ 6. return c.redirect(destination)                     ← visitor is gone, ~ms latency │
└─────────────────────────────────────────────────────────────────────────────────────┘
                    │
                    │ (background, after response is sent)
        ┌───────────┴────────────┐
        ▼                        ▼
   QUEUE.send(event)      LINK_CLICK_TRACKER_OBJECT
        │                 .idFromName(accountId).addClick(lat, lng, country, now)
        │                        │
        │                        ├─ INSERT into the DO's own SQLite table
        │                        └─ if no alarm pending → setAlarm(now + 2s)
        │                                    │
        │                          (2s later) alarm() fires
        │                                    ├─ SELECT clicks newer than last offset
        │                                    ├─ ctx.getWebSockets().forEach(ws => ws.send(json))
        │                                    ├─ persist new offsets
        │                                    └─ DELETE rows older than the batch
        │                                            │
        │                                            ▼
        │                                   Browser dashboard map animates
        ▼
  Queue consumer  DataService.queue(batch)
        ├─ QueueMessageSchema.safeParse(message.body)
        ├─ addLinkClicks(data)  → INSERT into D1 link_clicks
        └─ scheduleEvalWorkflow(env, event)
                 └─ EVALUATION_SCHEDULER.idFromName(`${linkId}:${destination}`)
                        .collectLinkClick(...)
                             ├─ storage.put('click_data', …)
                             └─ if no alarm pending → setAlarm(now + 24h)
                                          │
                              (24h later) alarm() fires
                                          └─ DESTINATION_EVALUATION_WORKFLOW.create({params})
                                                   │
                                    ┌──────────────┴───────────────┐
                                    │ Workflow (durable, retried)  │
                                    │ 1. Browser render page       │
                                    │ 2. Workers AI → in stock?    │
                                    │ 3. INSERT evaluation → D1    │
                                    │ 4. Archive html/text/png → R2│
                                    └──────────────────────────────┘
```

The single most important idea here: **`ctx.waitUntil()`**. In [app.ts:51](apps/data-service/src/hono/app.ts#L51):

```ts
c.executionCtx.waitUntil(captureLinkClickInBackground(c.env, queueMessage));
return c.redirect(destination);
```

The redirect is sent immediately; the runtime keeps the isolate alive to finish the analytics work. The visitor never pays for the queue send or the DO round-trip.

---

## 5. KV cache — deep dive

**File:** [apps/data-service/src/helpers/routing-ops.ts](apps/data-service/src/helpers/routing-ops.ts)

### What KV is

Workers KV is a **globally replicated, eventually-consistent key/value store**. Reads are extremely fast at the edge (values get cached in the local PoP); writes propagate globally in up to ~60 seconds. It's the wrong tool for "must be correct right now" data and the right tool for "reads massively outnumber writes and slightly stale is fine".

A link's destinations are exactly that: read on every single click, written rarely by the owner.

### The read-through pattern

```ts
const TTL_TIME = 60 * 60 * 24;  // 24 hours, in SECONDS

async function getLinkInfoFromKv(env: Env, id: string) {
  const linkInfo = await env.CACHE.get(id);      // returns string | null
  if (!linkInfo) return null;
  try {
    return linkSchema.parse(JSON.parse(linkInfo)); // validate — never trust the cache blindly
  } catch (error) {
    return null;                                   // corrupt/old shape → treat as a miss
  }
}

export async function getRoutingDestinations(env: Env, id: string) {
  const linkInfo = await getLinkInfoFromKv(env, id);
  if (linkInfo) return linkInfo;                   // HIT

  const linkInfoFromDB = await getLink(id);        // MISS → D1
  if (!linkInfoFromDB) return null;                // link doesn't exist at all

  await saveLinkInfoToKv(env, id, linkInfoFromDB); // warm the cache
  return linkInfoFromDB;
}
```

Three things worth internalising:

1. **Zod-parse on read.** If you ever change `linkSchema`, old cached blobs fail `parse`, fall into the `catch`, and are transparently re-fetched from D1. The cache self-heals on schema drift instead of serving garbage.
2. **The write is wrapped in try/catch and logged, never thrown** ([routing-ops.ts:19-27](apps/data-service/src/helpers/routing-ops.ts#L19-L27)). A cache write failure must not break a redirect. Caching is an optimisation, not a dependency.
3. **`expirationTtl`** is the *only* invalidation mechanism here. There is no `CACHE.delete(id)` anywhere in the codebase.

### The invalidation gap (important)

When a user edits destinations via tRPC:

```ts
// apps/user-application/worker/trpc/routers/links.ts
updateLinkDestinations: t.procedure.mutation(async ({ input }) => {
  await updateLinkDestinations(input.linkId, input.destinations);  // writes D1 only
})
```

D1 is updated, **KV is not touched**. The edge keeps serving the old destination for up to 24 hours. Also note `user-application` has no `CACHE` binding at all, so it *couldn't* purge even if it wanted to.

Ways to fix it, if you want to try:
- Add the `CACHE` KV binding to `user-application`'s wrangler config and `await env.CACHE.delete(linkId)` after every write.
- Or lower `TTL_TIME` (KV's minimum `expirationTtl` is 60 seconds).
- Or expose an internal purge route on `data-service` and call it via a service binding.

### KV API surface used here

```ts
env.CACHE.get(key)                                   // string | null
env.CACHE.put(key, value, { expirationTtl: seconds }) // value: string | ArrayBuffer | stream
// also available but unused: .get(key, "json"), .delete(key), .list({prefix}), metadata
```

---

## 6. Queues — deep dive

**Config:** [wrangler.jsonc:38-55](apps/data-service/wrangler.jsonc#L38-L55) · **Producer:** [routing-ops.ts:54-60](apps/data-service/src/helpers/routing-ops.ts#L54-L60) · **Consumer:** [index.ts:17-29](apps/data-service/src/index.ts#L17-L29) · **Handler:** [queue-handlers/link-clicks.ts](apps/data-service/src/queue-handlers/link-clicks.ts)

### Why a queue is here at all

Writing a click row to D1 takes tens of milliseconds and can fail. A redirect must not wait on it, and a click must not be lost if D1 hiccups. A queue converts "do this now, hope it works" into "durably record the intent, process with automatic retries".

It also gives you **batching**: instead of one D1 round trip per click, the consumer receives up to N messages at once.

### The config, line by line

```jsonc
"queues": {
  "producers": [
    { "binding": "QUEUE", "queue": "smart-links-data-queue-stage" }
  ],
  "consumers": [
    { "queue": "smart-links-data-queue-stage",
      "dead_letter_queue": "smart-links-data-dead-letter-queue-stage" },
    { "queue": "smart-links-data-dead-letter-queue-stage",
      "retry_delay": 0 }
  ]
}
```

- **producer** → gives you `env.QUEUE.send()` / `env.QUEUE.sendBatch()`.
- **first consumer** → this Worker's `queue()` handler is invoked with batches from the main queue. If a batch keeps failing past `max_retries` (default 3), messages land in the DLQ instead of vanishing.
- **second consumer** → this same Worker *also* consumes its own dead-letter queue. Failed messages get another lap through the exact same handler with no delay. The DLQ itself has no DLQ, so if they fail there too they're dropped permanently.

### Producing

```ts
export async function captureLinkClickInBackground(env: Env, event: LinkClickMessageType) {
  await env.QUEUE.send(event);   // structured-cloned, not JSON.stringify'd — objects go through as-is
  ...
}
```

### Consuming

```ts
async queue(batch: MessageBatch) {
  for (const message of batch.messages) {
    const parsedEvent = QueueMessageSchema.safeParse(message.body);
    if (parsedEvent.success) {
      const event = parsedEvent.data;
      if (event.type === 'LINK_CLICK') {
        await handleLinkClick(this.env, event);
      }
    } else {
      console.error(parsedEvent.error);   // malformed → log and drop
    }
  }
}
```

The message contract is a **Zod discriminated union** ([zod/queue.ts](packages/data-ops/src/zod/queue.ts)):

```ts
export const QueueMessageSchema = z.discriminatedUnion("type", [ LinkClickMessageSchema ]);
```

This is a deliberately extensible shape: add `EmailMessageSchema` with `type: z.literal("EMAIL")` to the union, add an `else if (event.type === 'EMAIL')` branch, and one queue carries many event kinds with full type narrowing.

### Ack semantics you should know

This handler uses **implicit acking**:
- Handler returns normally → every message in the batch is acked.
- Handler throws → the **entire batch** is retried, including messages that already succeeded.

Since `handleLinkClick` writes to D1 and then talks to a DO, a failure on message #7 of 10 means messages #1–6 get **re-inserted into `link_clicks`** on retry. There's no dedup key (`link_clicks` has no primary key — see [schema.ts:13-26](packages/data-ops/src/drizzle-out/schema.ts#L13-L26)), so retries can double-count clicks.

The explicit alternative, if you want per-message granularity:

```ts
for (const message of batch.messages) {
  try {
    await handleLinkClick(this.env, event);
    message.ack();                       // this one is done, never retry it
  } catch (e) {
    message.retry({ delaySeconds: 30 }); // only this one comes back
  }
}
```

Also note the two `await`s inside `handleLinkClick` run **serially per message**, and messages run serially in the loop. For higher throughput you'd `Promise.all` the batch.

---

## 7. Durable Objects — deep dive

Two DOs live here and they demonstrate **two completely different patterns** with the **two different storage backends**. Understanding the contrast is the fastest way to understand DOs.

### What a Durable Object actually is

A DO is a **named, single-threaded, stateful instance** of a class, with its own private storage, that Cloudflare guarantees exists in exactly one place in the world at a time.

- `namespace.idFromName("some-string")` → deterministically hashes the string into a `DurableObjectId`. Same string, anywhere on earth, same object.
- `namespace.get(id)` → a **stub**, a local proxy to that object.
- Calling a method on the stub is an RPC across the network to wherever the object lives.
- Because there's only one instance and it's single-threaded, you get **serialised access to state with no locks**. This is what makes DOs the coordination primitive on Cloudflare.

The DO "sleeps" when idle (evicted from memory) and is reconstructed on the next call — which is why the constructor has to restore state, and why alarms exist.

### Storage: classic vs SQLite

Look at the migrations block:

```jsonc
"migrations": [
  { "tag": "v1", "new_classes":        ["EvaluationScheduler"] },
  { "tag": "v2", "new_sqlite_classes": ["LinkClickTracker"]  }
]
```

| | `new_classes` (EvaluationScheduler) | `new_sqlite_classes` (LinkClickTracker) |
|---|---|---|
| Backend | Classic key-value storage | SQLite |
| API | `ctx.storage.get/put/delete/list` | Same KV API **plus** `ctx.storage.sql.exec()` |
| Good for | A handful of values | Rows, queries, ordering, aggregation |
| Availability of `ctx.storage.sql` | ❌ throws | ✅ |

**Migrations are append-only and permanent.** You cannot change a class from classic to SQLite by editing `v1` — you'd add a new tag. Deleting a class requires an explicit `deleted_classes` entry. Treat this array as a ledger.

---

### DO #1 — `EvaluationScheduler`: the debounce timer

**File:** [apps/data-service/src/durable-objects/evalutaion-scheduler.ts](apps/data-service/src/durable-objects/evalutaion-scheduler.ts)

**The problem it solves:** a popular link gets 50,000 clicks a day. You want to check whether its destination page is still selling the product — but *once a day*, not 50,000 times. You need a debounce that survives worker restarts and works across the whole globe.

**The identity trick** ([routing-ops.ts:48-52](apps/data-service/src/helpers/routing-ops.ts#L48-L52)):

```ts
const doId = env.EVALUATION_SCHEDULER.idFromName(`${event.data.id}:${event.data.destination}`);
```

One DO per **(link, destination URL)** pair. A link with 5 country destinations gets 5 independent schedulers. Every click on that pair, from any datacentre, routes to the same object.

**Restoring state on wake-up:**

```ts
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);
  ctx.blockConcurrencyWhile(async () => {
    this.clickData = await ctx.storage.get<ClickData>('click_data');
  });
}
```

`blockConcurrencyWhile` is critical. The constructor can't be `async`, so without it a method call could arrive and run against an unpopulated `this.clickData`. This call tells the runtime: **queue every incoming request until this promise resolves.** It's the standard DO hydration idiom.

**The debounce itself:**

```ts
async collectLinkClick(linkId, accountId, destinationUrl, destinationCountryCode) {
  this.clickData = { linkId, accountId, destinationCountryCode, destinationUrl };
  await this.ctx.storage.put('click_data', this.clickData);   // in-memory AND on disk

  const alarm = await this.ctx.storage.getAlarm();
  if (!alarm) {                                               // ← the whole debounce
    await this.ctx.storage.setAlarm(moment().add(24, 'hours').valueOf());
  }
}
```

`if (!alarm)` is the entire mechanism. Each DO can have **at most one pending alarm**; `setAlarm` overwrites. So:

- Click #1 → no alarm exists → schedule for T+24h.
- Clicks #2 … #50,000 over the next 24h → alarm exists → **do nothing but refresh the payload**.
- At T+24h `alarm()` runs, and `getAlarm()` now returns `null` again.
- The next click after that starts a fresh 24h window.

Note that state is written to **both** `this.clickData` (fast in-memory read) and `ctx.storage` (survives eviction). That dual-write is a normal DO pattern: memory is your cache, storage is your truth.

**The alarm handler:**

```ts
async alarm() {
  const clickData = this.clickData;
  if (!clickData) throw new Error('click data is not set');
  await this.env.DESTINATION_EVALUATION_WORKFLOW.create({
    params: { linkId: clickData.linkId, destinationUrl: clickData.destinationUrl, accountId: clickData.accountId },
  });
}
```

`alarm()` is a **reserved method name** — you don't call it, the runtime does. If it throws, the runtime **retries it with backoff**, which is why throwing on missing data is safe rather than silently swallowing.

This is also the hand-off point: DO (timer) → Workflow (long job). The DO stays tiny and fast; the heavy multi-minute work happens in a system built for it.

---

### DO #2 — `LinkClickTracker`: the live buffer + socket hub

**File:** [apps/data-service/src/durable-objects/link-click-tracker.ts](apps/data-service/src/durable-objects/link-click-tracker.ts)

**The problem it solves:** the dashboard wants a live map. Polling D1 every second from every open tab would hammer the database. Instead: one object per account holds a small rolling buffer of recent clicks and **pushes** them to whoever is watching.

**Identity:** `idFromName(accountId)` ([routing-ops.ts:56](apps/data-service/src/helpers/routing-ops.ts#L56)) — one tracker per account. All of an account's clicks worldwide funnel into one object, and all of that account's open dashboards attach to it.

**Constructor — hydrate scalars + create the table:**

```ts
this.sql = ctx.storage.sql;

ctx.blockConcurrencyWhile(async () => {
  const [leastRecentOffsetTime, mostRecentOffsetTime] = await Promise.all([
    ctx.storage.get<number>('leastRecentOffsetTime'),
    ctx.storage.get<number>('mostRecentOffsetTime'),
  ]);
  this.leastRecentOffsetTime = leastRecentOffsetTime || this.leastRecentOffsetTime;
  this.mostRecentOffsetTime  = mostRecentOffsetTime  || this.mostRecentOffsetTime;

  this.sql.exec(`
    CREATE TABLE IF NOT EXISTS geo_link_clicks (
      latitude REAL NOT NULL, longitude REAL NOT NULL,
      country TEXT NOT NULL,  time INTEGER NOT NULL
    )
  `);
});
```

Note the mix: **two scalars in KV storage, rows in SQL storage** — both live inside the same object. `CREATE TABLE IF NOT EXISTS` on every construction is the normal way to do DO schema setup (it's cheap and idempotent). The `Promise.all` reads both scalars in parallel.

**Writing a click:**

```ts
async addClick(latitude: number, longitude: number, country: string, time: number) {
  this.sql.exec(
    `INSERT INTO geo_link_clicks (latitude, longitude, country, time) VALUES (?, ?, ?, ?)`,
    latitude, longitude, country, time,
  );
  const alarm = await this.ctx.storage.getAlarm();
  if (!alarm) await this.ctx.storage.setAlarm(moment().add(2, 'seconds').valueOf());
}
```

Same `if (!alarm)` debounce as the scheduler — just with a 2-second window instead of 24 hours. 500 clicks in two seconds produce **one** flush, not 500 socket messages. This is coalescing/batching via alarms, and it's the pattern to remember.

`this.sql.exec(query, ...params)` uses positional `?` binding — parameterised, so no injection risk.

**The flush (`alarm()`):**

```ts
async alarm() {
  const clickData = getRecentClicks(this.sql, this.mostRecentOffsetTime);

  const sockets = this.ctx.getWebSockets();
  for (const socket of sockets) socket.send(JSON.stringify(clickData.clicks));

  await this.flushOffsetTimes(clickData.mostRecentTime, clickData.oldestTime);
  await deleteClicksBefore(this.sql, clickData.oldestTime);
}
```

And the queries ([helpers/durable-queries.ts](apps/data-service/src/helpers/durable-queries.ts)):

```ts
SELECT latitude, longitude, country, time
FROM geo_link_clicks
WHERE time > ?          -- only clicks newer than what we already sent
ORDER BY time DESC
LIMIT ?                 -- 50
```

```ts
const clicks = durableObjectGeoClickArraySchema.parse(cursor.toArray());
const mostRecentTime = clicks.length > 0 ? clicks[0].time : 0;                 // newest
const oldestTime     = clicks.length > 0 ? clicks[clicks.length - 1].time : 0; // oldest in batch
```

The **offset-cursor** design:

- `mostRecentOffsetTime` is the high-water mark. Next flush only selects `time > mostRecentOffsetTime`, so **no click is ever sent twice**.
- After sending, `DELETE FROM geo_link_clicks WHERE time < oldestTime` prunes anything older than this batch. The DO's SQLite stays a small rolling window instead of growing forever.
- Overflow behaviour: with `ORDER BY time DESC LIMIT 50`, if 200 clicks arrive in one 2-second window, you get the **newest 50**, and the other 150 are then deleted by the prune. For a live map that's the right trade — freshness over completeness. (The durable record of all 200 is in D1 via the queue anyway.)

**The alarm chain is data-driven, not periodic.** `alarm()` never reschedules itself. Once it fires, `getAlarm()` returns `null`, so the loop restarts only when the next `addClick` arrives. Zero clicks → zero alarms → the DO goes idle and costs nothing.

`flushOffsetTimes` writes the cursors to both memory and storage, so an evicted-and-reconstructed DO resumes exactly where it left off.

---

## 8. WebSockets — deep dive

Three pieces: the upgrade handshake, the DO-side hibernation API, and the React client.

### 8a. The handshake (Worker side)

```ts
// apps/data-service/src/hono/app.ts
App.get('/click-socket', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader !== 'websocket') {
    return c.text('Expected Upgrade: websocket', 426);   // 426 Upgrade Required
  }

  // const accountId = c.req.header('account-id');
  const accountId = '1234567890';                        // ⚠️ hardcoded — auth is stubbed
  if (!accountId) return c.text('NO header found', 404);

  const doId = c.env.LINK_CLICK_TRACKER_OBJECT.idFromName(accountId);
  const stub = c.env.LINK_CLICK_TRACKER_OBJECT.get(doId);
  return await stub.fetch(c.req.raw);                    // hand the raw upgrade request to the DO
});
```

The Worker itself doesn't terminate the socket. It **routes the upgrade request to the right DO** and returns whatever the DO returns. `c.req.raw` is the untouched `Request` — you must forward the original, since the upgrade machinery depends on its headers.

Why must it be a DO? A regular Worker is stateless and ephemeral — there's no "the" instance to hold your connections. A DO is a single, addressable, long-lived place, so every dashboard for account X lands on the same object and one `alarm()` can fan out to all of them.

### 8b. Accepting the socket (DO side)

```ts
async fetch(_: Request) {
  const webSocketPair = new WebSocketPair();
  const [client, server] = Object.values(webSocketPair);

  this.ctx.acceptWebSocket(server);          // ← hibernation API

  return new Response(null, {
    status: 101,                             // Switching Protocols
    webSocket: client,                       // the half that goes back to the browser
  });
}
```

`new WebSocketPair()` creates two linked ends. The **server** end stays in the DO; the **client** end is returned in the 101 response and becomes the browser's socket.

The key call is **`this.ctx.acceptWebSocket(server)`**, not `server.accept()`. The difference matters a lot:

| | `server.accept()` (standard) | `ctx.acceptWebSocket(server)` (hibernation) |
|---|---|---|
| DO stays in memory | Yes, as long as the socket is open — you're billed for it | No, can be evicted while the socket stays open |
| Event handling | `server.addEventListener('message', ...)` | Class methods: `webSocketMessage()`, `webSocketClose()`, `webSocketError()` |
| Retrieving sockets later | You must store them yourself in an array | `this.ctx.getWebSockets()` — the runtime tracks them for you |
| Survives eviction | Connections die | Connections survive; DO is revived on the next event |

Hibernation is what makes "1,000 dashboards open overnight" cheap. The DO isn't resident in memory; it wakes for the alarm, sends, and goes back to sleep.

Because of hibernation, the broadcast reads the socket list from the runtime rather than from a field:

```ts
const sockets = this.ctx.getWebSockets();
for (const socket of sockets) socket.send(JSON.stringify(clickData.clicks));
```

`webSocketClose` is defined and just logs — the runtime cleans up the socket, so nothing more is required:

```ts
webSocketClose(ws, code, reason, wasClean) { console.log('client closed'); }
```

There is deliberately **no `webSocketMessage` handler**: this is a one-way push channel. Anything the browser sends is ignored.

### 8c. The client (React)

**File:** [apps/user-application/src/hooks/clicks-socket.ts](apps/user-application/src/hooks/clicks-socket.ts)

```ts
const socket = new WebSocket(`${protocol}//data-service.taqdeesm99.workers.dev/click-socket`);

socket.onopen = () => { setIsConnected(true); retryCountRef.current = 0; };

socket.onmessage = (event) => {
  const data = durableObjectGeoClickArraySchema.parse(JSON.parse(event.data));  // same Zod schema as the server
  addClicks(data);                                                              // → zustand
};

socket.onclose = () => {
  setIsConnected(false);
  if (retryCountRef.current < MAX_RETRIES) {
    const delay = 1000 * Math.pow(2, retryCountRef.current);  // 1s, 2s, 4s, 8s, 16s
    retryCountRef.current++;
    retryTimeoutRef.current = setTimeout(() => connect(), delay);
  }
};
```

Points worth noting:

- **Exponential backoff with a retry cap.** Reconnects at 1/2/4/8/16 seconds, then gives up. The counter resets to 0 on a successful `onopen`.
- **The same Zod schema validates on both ends.** `durableObjectGeoClickArraySchema` is defined once in [packages/data-ops/src/zod/links.ts](packages/data-ops/src/zod/links.ts) and used by the DO (`getRecentClicks`) and the browser. One source of truth for the wire format.
- **Cleanup on unmount** clears the pending retry timer *and* closes the socket — without the first, a timer could fire after unmount and open an orphan connection.
- Refs (`useRef`) rather than state hold the socket and counters, so reconnect logic doesn't trigger re-renders and the `useEffect` can stay `[]`-dependency.
- The URL is **hardcoded to the deployed data-service**, and `protocol` is `"wss:"` in both branches of the ternary — so it always uses `wss://` even on localhost. That's why the live map talks to prod even in dev.

### 8d. Where the data lands

[geo-clicks-store.ts](apps/user-application/src/hooks/geo-clicks-store.ts) — a zustand store, capped at 1,000 entries:

```ts
addClicks: (clicks) => set((state) => {
  const updated = [...state.clicks, ...clicks];
  return updated.length > 1000 ? { clicks: updated.slice(-1000) } : { clicks: updated };
}),
```

[active-areas-map.tsx](apps/user-application/src/components/dashboard/active-areas-map.tsx) subscribes, groups nearby points with `groupClicksByMile` (rounds lat/lng to ~0.0145° buckets and counts), and renders animated pulsing SVG circles on a `react-simple-maps` world projection. Marker radius scales with the bucket's count.

**End to end:** click → `waitUntil` → DO `addClick` → 2s alarm → `getWebSockets().send()` → `onmessage` → Zod parse → zustand → React re-render → pulse on the map. Typical latency: about two seconds.

---

## 9. Workflows — deep dive

**File:** [apps/data-service/src/workflows/destination-evaluation-workflow.ts](apps/data-service/src/workflows/destination-evaluation-workflow.ts)

### What a Workflow is

Cloudflare Workflows give you **durable execution**. You write what looks like a normal async function, but each `step.do()` boundary is a checkpoint:

- The step's **return value is persisted**.
- If a step fails, only that step is **retried** (with configurable backoff), not the whole run.
- If the run is interrupted — deploy, crash, machine failure — it resumes from the last completed step, replaying earlier steps from their saved results instead of re-running them.
- A run can outlive normal Worker limits (steps can sleep for days).

That's exactly what this job needs: launching a browser and calling an LLM are slow and flaky, and you don't want an LLM failure to force a second browser render.

### The four steps

```ts
export class DestinationEvaluationWorkflow extends WorkflowEntrypoint<Env, unknown> {
  async run(event: Readonly<WorkflowEvent<DestinationStatusEvaluationParams>>, step: WorkflowStep) {
    initDatabase(this.env.DB);   // the workflow runs in its own isolate — must init Drizzle again

    // 1 — headless browser render
    const collectedData = await step.do('Collect rendered destination page data', async () => {
      return collectDestinationInfo(this.env, event.payload.destinationUrl);
    });

    // 2 — LLM classification, explicitly NOT retried
    const aiStatus = await step.do('Use AI to check status of page',
      { retries: { limit: 0, delay: 0 } },
      async () => aiDestinationChecker(this.env, collectedData.bodyText),
    );

    // 3 — persist the verdict, return the new row id
    const evaluationId = await step.do('Save evaluation in Database', async () => {
      return await addEvaluation({
        linkId: event.payload.linkId, status: aiStatus.status, reason: aiStatus.statusReason,
        accountId: event.payload.accountId, destinationUrl: event.payload.destinationUrl,
      });
    });

    // 4 — archive artifacts to R2 under that id
    await step.do('Backup destination HTML in R2', async () => { /* three BUCKET.put calls */ });
  }
}
```

Details that matter:

- **`event.payload`** is the `params` object passed to `.create()` by the scheduler DO, typed by `DestinationStatusEvaluationParams` in [service-bindings.d.ts](apps/data-service/service-bindings.d.ts).
- **Step names are identifiers, not comments.** `'Collect rendered destination page data'` is how the engine keys the checkpoint. Renaming a step in a deployed workflow makes in-flight runs treat it as a brand-new step.
- **`{ retries: { limit: 0, delay: 0 } }` on the AI step** overrides the default retry policy — one shot, no retries. Sensible: a nondeterministic LLM that failed to produce schema-valid output will likely fail the same way again, and each attempt costs inference.
- **Step return values must be serialisable** — they're persisted. That's why step 1 returns plain strings (`bodyText`, `html`, base64 screenshot) and not a live Puppeteer `Page` object.
- **`initDatabase(this.env.DB)` is called again** here. The module-level Drizzle singleton in [database.ts](packages/data-ops/src/db/database.ts) lives per-isolate, and a Workflow instance is a different execution context than the `fetch`/`queue` handlers — so it needs its own init.
- Step 4 depends on step 3's `evaluationId` to build R2 keys, which is why the DB write comes before the archive.

### Type wiring

```ts
DESTINATION_EVALUATION_WORKFLOW:
  Workflow<Parameters<import("./src/index").DestinationEvaluationWorkflow['run']>[0]['payload']>
```

Wrangler's generated types extract the payload type straight from your `run` signature, so `.create({ params: … })` is type-checked against the workflow's own definition. Change the params interface and every call site fails to compile.

---

## 10. Browser Rendering + Workers AI + R2

### Browser Rendering

[apps/data-service/src/helpers/browser-render.ts](apps/data-service/src/helpers/browser-render.ts)

```ts
const browser = await puppeteer.launch(env.VIRTUAL_BROWSER);   // binding, not a local Chrome
const page = await browser.newPage();
const response = await page.goto(destinationUrl);
await page.waitForNetworkIdle();                               // let SPA content settle

const bodyText = (await page.$eval('body', (el) => el.innerText)) as string;
const html = await page.content();
const status = response ? response.status() : 0;
const screenshot = await page.screenshot({ encoding: 'base64' });

await browser.close();                                          // always release the browser
```

Real Chrome, running in Cloudflare's fleet, driven by `@cloudflare/puppeteer`. Why render instead of `fetch()`? Modern ecommerce pages set "Out of stock" via JavaScript after load — raw HTML from a fetch would miss it. `waitForNetworkIdle()` then `innerText` gives you what a human would actually see.

`innerText` (not `textContent`) is deliberate: it respects rendering, skipping hidden elements — a much cleaner signal for the LLM.

### Workers AI

[apps/data-service/src/helpers/ai-destination-checker.ts](apps/data-service/src/helpers/ai-destination-checker.ts)

```ts
const workersAi = createWorkersAI({ binding: env.AI });

const { output } = await generateText({
  model: workersAi('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b' as any) as any,
  system: "You are an AI assistant for ecommerce analysis...",
  prompt: `...\n---\nWebpage Content:\n${bodyText}`,
  experimental_output: Output.object({ schema: outputSchema }),   // structured output
  stopWhen: stepCountIs(2),
});

return { status: output.pageStatus.status, statusReason: output.pageStatus.statusReason };
```

The Vercel AI SDK (`ai`) with the `workers-ai-provider` adapter, so inference runs on Cloudflare's GPUs via the `AI` binding — no external API key, no egress.

The important technique is **structured output**: `outputSchema` is a Zod object whose `.describe()` strings are part of the prompt contract:

```ts
status: z.enum(['AVAILABLE_PRODUCT', 'NOT_AVAILABLE_PRODUCT', 'UNKNOWN_STATUS'], {
  description: `Indicates the product's availability on the page: ...`
}),
statusReason: z.string().describe(`A concise explanation citing specific words...`)
```

The schema is converted to a JSON-schema the model must fill, and the response is validated against it. You get a typed object instead of prose you'd have to regex. The explicit `UNKNOWN_STATUS` option plus "Do not guess if information is insufficient" in the system prompt gives the model a legitimate escape hatch, which reduces confident wrong answers.

`status` feeds `destination_evaluations.status`, and the dashboard's "problematic links" panel queries exactly `status === 'NOT_AVAILABLE_PRODUCT'` ([queries/evaluations.ts](packages/data-ops/src/queries/evaluations.ts)).

### R2

Step 4 of the workflow:

```ts
const r2PathHTML       = `evaluations/${accountId}/html/${evaluationId}`;
const r2PathBodyText   = `evaluations/${accountId}/body-text/${evaluationId}`;
const r2PathScreenshot = `evaluations/${accountId}/screenshots/${evaluationId}.png`;

const screenshotBase64 = collectedData.screenshotDataUrl.replace(/^data:image\/png;base64,/, '');
const screenshotBUffer = Buffer.from(screenshotBase64, 'base64');

await this.env.BUCKET.put(r2PathHTML, collectedData.html);
await this.env.BUCKET.put(r2PathBodyText, collectedData.bodyText);
await this.env.BUCKET.put(r2PathScreenshot, screenshotBUffer);
```

R2 is S3-compatible object storage with **no egress fees**. Here it's the audit trail: when the AI says "out of stock", you can pull up the exact HTML and screenshot it judged. D1 holds the small queryable verdict; R2 holds the big blobs. That split — metadata in the database, bytes in object storage — is the standard pattern.

The key prefixes are hierarchical (`evaluations/{accountId}/{kind}/{id}`) so you can `list({ prefix: 'evaluations/123/' })` per account. `Buffer` here requires the `nodejs_compat` compatibility flag, which is set in [wrangler.jsonc:10](apps/data-service/wrangler.jsonc#L10).

---

## 11. D1 + Drizzle + the data-ops package

### D1

SQLite, replicated at the edge, accessed through the `DB` binding. Both Workers bind the same `database_id`. `"remote": true` in the wrangler configs means even `wrangler dev` talks to the **real remote database** rather than a local sqlite file — convenient, but remember your local dev writes are real.

### Schema

[packages/data-ops/src/drizzle-out/schema.ts](packages/data-ops/src/drizzle-out/schema.ts)

```ts
links                    → link_id (PK), account_id, destinations (JSON string), created, updated, name
link_clicks              → id, account_id, country, destination, clicked_time, latitude, longitude
                           indexes on account_id, clicked_time, id
destination_evaluations  → id (PK, uuid), link_id, account_id, destination_url, status, reason, created_at
                           composite index on (account_id, created_at)
```

The `drizzle-out/` folder name is a hint: this schema was **pulled from the live database** (`pnpm --filter @repo/data-ops pull`, see [drizzle.config.ts](packages/data-ops/drizzle.config.ts)), not authored by hand. The workflow is DB-first: change the DB, re-pull, rebuild the package.

`destinations` is stored as a **JSON string in a single column**, which is why `destinationsSchema` has a `z.preprocess` that `JSON.parse`s strings:

```ts
export const destinationsSchema = z.preprocess(
  (obj) => (typeof obj === "string" ? JSON.parse(obj) : obj),
  z.object({ default: z.string().url() }).catchall(z.string().url()),
);
```

`.catchall(z.string().url())` is the trick that allows arbitrary country-code keys while **requiring** `default`. So `{ default: "...", US: "...", DE: "..." }` validates, and a missing `default` fails — which is what makes `getDestinationsForCountry`'s fallback safe:

```ts
export function getDestinationsForCountry(linkInfo: LinkSchemaType, countryCode?: string) {
  if (!countryCode) return linkInfo.destinations.default;
  if (linkInfo.destinations[countryCode]) return linkInfo.destinations[countryCode];
  return linkInfo.destinations.default;
}
```

### The Drizzle singleton

```ts
// packages/data-ops/src/db/database.ts
let db: ReturnType<typeof drizzle>;
export function initDatabase(bindingDb: D1Database) { if (db) return; db = drizzle(bindingDb); }
export function getDb() { if (!db) throw new Error("Database not initialized"); return db; }
```

Module-level state, initialised once per isolate. Every query function calls `getDb()` and therefore needs **no `env` parameter** — that's why `addLinkClicks(event.data)` and `getLink(id)` read so cleanly. The cost is that every new execution context must call `initDatabase` first, which is why you see it in three places: the `DataService` constructor, the `user-application` fetch handler, and the workflow's `run`.

---

## 12. The frontend: tRPC, TanStack, zustand

**Stack:** Vite + React 19 + TanStack Router (file-based) + TanStack Query + tRPC + Tailwind/shadcn + zustand.

### tRPC end to end

Server ([worker/trpc/](apps/user-application/worker/trpc/)):

```ts
export const appRouter = t.router({ links: linksTrpcRoutes, evaluations: evaluationsTrpcRoutes });
export type AppRouter = typeof appRouter;
```

Client ([src/router.tsx](apps/user-application/src/router.tsx)):

```ts
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: createTRPCClient({ links: [ httpBatchLink({ url: "/trpc" }) ] }),
  queryClient,
});
```

The client imports **the server's type** (`AppRouter`) directly — no codegen, no OpenAPI. Rename a procedure on the server and the frontend fails to compile. `httpBatchLink` coalesces multiple procedure calls made in the same tick into one HTTP request.

Routes prefetch through the router's loader so data is ready before the component renders ([routes/app/_authed/index.tsx](apps/user-application/src/routes/app/_authed/index.tsx)):

```ts
loader: async ({ context }) => {
  await Promise.all([
    context.queryClient.prefetchQuery(context.trpc.links.activeLinks.queryOptions()),
    ...
  ]);
}
```

### Two data paths, deliberately

| | Path | Update model |
|---|---|---|
| Historical / aggregate | React → tRPC → D1 | request/response, cached by TanStack Query |
| Live clicks | DO → WebSocket → zustand | push, ~2s cadence |

They're kept separate on purpose. Query cache for things you ask for; a plain store for a firehose you subscribe to.

### Auth is stubbed

- `createContext` hardcodes `userInfo.userId = "1234567890"` ([context.ts](apps/user-application/worker/trpc/context.ts)).
- The socket route hardcodes the same account id, with the real header read commented out.
- `_authed.tsx` is a layout route only — it does no auth checking.
- `better-auth` is installed and there's an [auth-gen/auth.ts](packages/data-ops/auth-gen/auth.ts) config plus login components, but nothing enforces identity yet.

So today every visitor is account `1234567890`. Wiring real auth means: authenticate → put the real account id in the tRPC context → pass it to the socket route (header or query param) → and the DO sharding by `idFromName(accountId)` already gives you per-account isolation for free.

---

## 13. Running it locally & deploying

```bash
pnpm install

# 1. ALWAYS build the shared package first (and after any edit to it)
pnpm build-package

# 2. In two terminals:
pnpm dev-data-service     # wrangler dev  → the edge engine
pnpm dev-frontend         # vite          → the dashboard

# Deploy
pnpm --filter data-service run deploy      # wrangler deploy
pnpm --filter user-application run deploy
```

Local-dev caveats specific to this repo:

- `"remote": true` on D1 and KV means dev hits **real remote** D1/KV.
- Queues, DOs, alarms, and Workflows are simulated by `workerd` locally and generally work well.
- The dashboard's WebSocket URL is hardcoded to the **deployed** data-service, so the live map in local dev shows production clicks, not your local ones. Point it at `ws://localhost:8787/click-socket` to test locally (and fix the always-`wss:` ternary).
- Browser Rendering and Workers AI require real Cloudflare resources.

Regenerating types after changing bindings:

```bash
pnpm --filter data-service run cf-typegen     # wrangler types --env-interface BaseEnv
```

This rewrites `worker-configuration.d.ts` and is what makes `env.CACHE`, `env.LINK_CLICK_TRACKER_OBJECT`, etc. type-safe. Run it every time you edit `wrangler.jsonc`.

---

## 14. Known bugs and rough edges

Things I found reading the code. Fixing these is a good way to prove you understand the systems.

1. **Swapped arguments into the scheduler DO.**
   [routing-ops.ts:51](apps/data-service/src/helpers/routing-ops.ts#L51) calls:
   ```ts
   stub.collectLinkClick(event.data.accountId, event.data.id, event.data.destination, ...)
   ```
   but the signature is `collectLinkClick(linkId, accountId, destinationUrl, destinationCountryCode)`. So `linkId` receives the account id and `accountId` receives the link id — and those swapped values are stored and later passed into the workflow, ending up reversed in `destination_evaluations`. (This is the same class of bug as the lat/lng swap fixed in commit `08fbe87`; consider passing an object instead of positional args so it can't recur.)

2. **KV is never invalidated on write.** Editing a link's destinations updates D1 only; the edge serves stale routes for up to 24h. See [§5](#5-kv-cache--deep-dive).

3. **Whole-batch queue retries can double-count clicks.** No explicit `ack()`/`retry()`, and `link_clicks` has no unique key, so a partial batch failure re-inserts already-processed rows.

4. **The DLQ consumer runs the identical handler with `retry_delay: 0`.** A message that fails deterministically burns through its DLQ retries immediately and is then dropped. Usually a DLQ consumer should log/alert/park, not blindly reprocess.

5. **Empty-flush offset reset.** In `getRecentClicks`, an empty result yields `mostRecentTime = 0`, and `flushOffsetTimes(0, 0)` resets the high-water mark to zero. Undeleted rows would then be re-sent on the next flush, duplicating markers. It's a narrow window (the `time > ?` comparison is strict, so a click landing in the same millisecond as the last flushed one can produce it), but the safe fix is to skip the flush entirely when `clicks.length === 0`.

6. **Hardcoded account id in two places** (`app.ts` socket route, tRPC `createContext`) — see [§12](#12-the-frontend-trpc-tanstack-zustand).

7. **`protocol` ternary always yields `wss:`** in [clicks-socket.ts:17](apps/user-application/src/hooks/clicks-socket.ts#L17) — both branches are the same string.

8. **Dummy data in the dashboard.** `totalLinkClickLastHour`, `last24HourClicks`, `last30DaysClicks`, `activeLinks`, `clicksByCountry` return hardcoded values from [dummy-data.ts](apps/user-application/worker/trpc/routers/dummy-data.ts); `getLinks` fabricates `lastSixHours` with `Math.random()`. Real aggregate queries over `link_clicks` are still to be written.

9. **`recentEvaluations` queries `"testaccountId"`** instead of `ctx.userInfo.userId` ([evaluations.ts](apps/user-application/worker/trpc/routers/evaluations.ts)), and its `createdBefore` input is accepted but never passed to the query, so pagination doesn't work.

10. **`packages/data-ops/.env` is committed** and the D1 database id is in the wrangler configs. Ids in wrangler config are normal; make sure no API token is in that `.env`.

11. **Unused scaffolding:** [durable-object-helpers/geo-link-clicks.ts](packages/data-ops/src/durable-object-helpers/geo-link-clicks.ts) defines a Drizzle-for-DO-SQLite schema that nothing imports (the DO uses raw SQL), and the package's `exports` map has a typo mismatch — the key is `"./durable-objects-helpers"` while the folder is `durable-object-helpers`.

---

## 15. Cheat sheet: which primitive, and why

| Need | Primitive | Where in this repo |
|---|---|---|
| Read-heavy config, stale-tolerable | **KV** | Link destinations cache |
| Relational, queryable, transactional | **D1** | links, clicks, evaluations |
| Big blobs, cheap egress | **R2** | HTML / body text / screenshots |
| Decouple work from the request path, retry on failure | **Queues** | Click ingest → D1 |
| Do work after responding, same request | **`ctx.waitUntil`** | Queue send + DO write on redirect |
| Single point of coordination for a key | **Durable Object** | One tracker per account, one scheduler per link+destination |
| Timers that survive restarts | **DO alarms** | 2s flush; 24h debounce |
| Rows + queries inside a DO | **SQLite DO** (`new_sqlite_classes`) | `LinkClickTracker` |
| Long-lived push connection | **WebSocket hibernation** (`ctx.acceptWebSocket`) | Live map feed |
| Multi-step job that must survive failure | **Workflows** | Destination evaluation |
| Render JS-heavy pages | **Browser Rendering** | Puppeteer via `VIRTUAL_BROWSER` |
| LLM inference, no external key | **Workers AI** | In-stock classification |
| Type-safe client↔server API | **tRPC** | Dashboard queries |
| One validation source of truth | **Zod in a shared package** | Queue messages, links, socket payloads |

### Five ideas to actually remember

1. **`ctx.waitUntil` decouples latency from work.** Respond first, do the bookkeeping after.
2. **`if (!alarm) setAlarm(...)` is the universal DO debounce.** Both DOs use it; only the window differs (2s vs 24h). It coalesces N events into one action.
3. **`idFromName(key)` is your sharding decision.** Pick the key and you've picked your unit of coordination and your concurrency granularity: per account for the socket hub, per link+destination for the scheduler.
4. **Hibernation (`ctx.acceptWebSocket`) makes idle connections nearly free** — but it's why the handlers are class methods and why sockets are read back via `ctx.getWebSockets()`.
5. **Validate at every boundary with one shared schema.** The same Zod objects guard the queue message, the KV blob, the D1 row, and the WebSocket frame. Anything that crosses a process boundary in this codebase gets parsed.

### Suggested reading order for the code

1. [apps/data-service/src/hono/app.ts](apps/data-service/src/hono/app.ts) — the entry point of everything
2. [apps/data-service/src/helpers/routing-ops.ts](apps/data-service/src/helpers/routing-ops.ts) — KV + queue + both DO calls in 60 lines
3. [apps/data-service/src/index.ts](apps/data-service/src/index.ts) — the queue consumer
4. [apps/data-service/src/durable-objects/evalutaion-scheduler.ts](apps/data-service/src/durable-objects/evalutaion-scheduler.ts) — the simplest DO
5. [apps/data-service/src/durable-objects/link-click-tracker.ts](apps/data-service/src/durable-objects/link-click-tracker.ts) — SQLite DO + WebSockets + alarms
6. [apps/data-service/src/workflows/destination-evaluation-workflow.ts](apps/data-service/src/workflows/destination-evaluation-workflow.ts) — durable execution
7. [apps/user-application/src/hooks/clicks-socket.ts](apps/user-application/src/hooks/clicks-socket.ts) — the other end of the socket
