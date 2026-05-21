import { describe, expect, it } from 'vitest';

import { MetricsRegistry, NoopMetricsRegistry } from '../../src/metrics/index.js';

describe('MetricsRegistry', () => {
  it('records calls with labels and renders text output', async () => {
    const m = new MetricsRegistry({ collectDefault: false });
    m.recordCall('Counter', 'inc', 'ok');
    m.recordCall('Counter', 'inc', 'ok');
    m.recordCall('Counter', 'dec', 'error');
    const out = await m.render();
    expect(out).toContain('actjs_actor_message_total{class="Counter",method="inc",outcome="ok"} 2');
    expect(out).toContain(
      'actjs_actor_message_total{class="Counter",method="dec",outcome="error"} 1',
    );
  });

  it('buckets into _other when the per-class method cap is hit', async () => {
    const m = new MetricsRegistry({ collectDefault: false, methodLimit: 2 });
    m.recordCall('C', 'a', 'ok');
    m.recordCall('C', 'b', 'ok');
    m.recordCall('C', 'c', 'ok'); // → bucketed
    m.recordCall('C', 'd', 'ok'); // → bucketed
    const out = await m.render();
    expect(out).toContain('actjs_actor_message_total{class="C",method="a",outcome="ok"} 1');
    expect(out).toContain('actjs_actor_message_total{class="C",method="b",outcome="ok"} 1');
    expect(out).toContain('actjs_actor_message_total{class="C",method="_other",outcome="ok"} 2');
    expect(out).not.toContain('method="c"');
    expect(out).not.toContain('method="d"');
  });

  it('tracks active-actor gauges per class+version', async () => {
    const m = new MetricsRegistry({ collectDefault: false });
    m.recordActivation('Note', '1.0.0', 1);
    m.recordActivation('Note', '1.0.0', 1);
    m.recordActivation('Note', '1.0.0', -1);
    const out = await m.render();
    expect(out).toContain('actjs_actor_active{class="Note",version="1.0.0"} 1');
  });

  it('NoopMetricsRegistry is a true no-op', async () => {
    const m = new NoopMetricsRegistry();
    m.recordCall('X', 'y', 'ok');
    m.recordActivation('X', '1.0.0', 1);
    m.recordEventAppend('X');
    const out = await m.render();
    // None of the override no-ops should produce *sample* lines —
    // only the HELP/TYPE banners that prom-client emits on
    // registration.
    expect(out).not.toMatch(/actjs_actor_message_total\{/);
    expect(out).not.toMatch(/actjs_actor_active\{/);
  });
});
