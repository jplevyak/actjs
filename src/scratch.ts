// Scratch test for the actor framework, runnable standalone:
//   npx tsx src/scratch.ts
import { createClient, type RedisClientType } from 'redis';

import GAct, { Actor, type RedisLike } from './gact.js';

const client = createClient() as RedisClientType;
client.on('error', (err: unknown) => console.error('redis error:', err));
await client.connect();

const gact = new GAct(1, client as unknown as RedisLike);
const c = new Actor(gact);
c['c'] = 'c';
const d = new Actor(gact);
d['d'] = 'd';
c['d'] = d;

const committed = await gact.commit();
console.info('committed:', committed, 'root id:', c.actor_id);

const gact2 = new GAct(2, client as unknown as RedisLike);
const cc = await gact2.load(c.actor_id);
if (cc) {
  console.info('reloaded c.c =', cc['c']);
  const reloadedD = (await cc['d']) as Actor;
  console.info('reloaded c.d.d =', reloadedD['d']);
}

await client.quit();
