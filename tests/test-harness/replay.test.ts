/**
 * `replayMigrations` exercise: feed two historical snapshots through
 * a class with a `migrate()` function and assert the diff.
 */
import { describe, expect, it } from 'vitest';

import { Actor } from '../../src/actor.js';
import { replayMigrations } from '../../src/test/index.js';

interface NoteState {
  title: string;
  /** `body` was renamed from `text` in v2. */
  body: string;
}

class Note extends Actor<NoteState> {
  override migrate(prev: unknown, prevVersion: string): NoteState {
    if (prevVersion === '1.0.0') {
      const old = prev as { title: string; text: string };
      return { title: old.title, body: old.text };
    }
    return prev as NoteState;
  }
}

describe('replayMigrations', () => {
  it('walks each snapshot through migrate() and reports the diff', async () => {
    const report = await replayMigrations({
      ctor: Note,
      targetVersion: '2.0.0',
      snapshots: [
        { version: '1.0.0', state: { title: 'a', text: 'hello' } },
        { version: '2.0.0', state: { title: 'b', body: 'world' } },
      ],
    });
    expect(report.failures).toBe(0);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]!.after).toEqual({ title: 'a', body: 'hello' });
    expect(report.results[1]!.after).toEqual({ title: 'b', body: 'world' });
  });

  it('captures thrown errors per snapshot without aborting the loop', async () => {
    class BadMigrate extends Actor<{ x: number }> {
      override migrate(): { x: number } {
        throw new Error('cannot migrate');
      }
    }
    const report = await replayMigrations({
      ctor: BadMigrate,
      snapshots: [
        { version: '0.9.0', state: { x: 1 } },
        { version: '0.9.0', state: { x: 2 } },
      ],
    });
    expect(report.failures).toBe(2);
    expect(report.results.every((r) => !r.ok && r.error?.includes('cannot migrate'))).toBe(true);
  });
});
