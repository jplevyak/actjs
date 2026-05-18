// Scratch test for the actor framework, runnable standalone:
//   node x.js
import { createClient } from 'redis';
import GAct from './gact.js';

const client = createClient();
client.on('error', (err) => console.error('redis error:', err));
await client.connect();

const gact = new GAct(1, client);
const c = new gact.Actor(gact);
c.c = 'c';
c.d = new gact.Actor(gact);
c.d.d = 'd';

const committed = await gact.commit();
console.log('committed:', committed, 'root id:', c.actor_id);

const gact2 = new GAct(2, client);
const cc = await gact2.load(c.actor_id);
console.log('reloaded c.c =', cc.c);
console.log('reloaded c.d.d =', (await cc.d).d);

await client.quit();
