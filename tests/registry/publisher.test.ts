import { describe, expect, it } from 'vitest';

import {
  IncompatibleEngine,
  InvalidDepRange,
  InvalidVersion,
  SyntaxInvalid,
  publishClass,
  validatePublish,
} from '../../src/registry/index.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { VersionAlreadyPublishedError } from '../../src/storage/driver.js';
import { asClassName, asVersion } from '../../src/types/index.js';

const VALID_SOURCE = `
class Counter extends gact.Actor {
  constructor() { super(); }
}
return Counter;
`;

describe('validatePublish', () => {
  it('accepts a well-formed input', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        source: VALID_SOURCE,
        deps: {},
        engines: {},
      }),
    ).not.toThrow();
  });

  it('rejects a non-semver version', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Counter'),
        version: asVersion('not-a-version'),
        source: VALID_SOURCE,
      }),
    ).toThrow(InvalidVersion);
  });

  it('rejects a bad semver range in deps', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        source: VALID_SOURCE,
        deps: { Item: 'not-a-range' },
      }),
    ).toThrow(InvalidDepRange);
  });

  it('rejects an engines.actjs that does not satisfy the server', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        source: VALID_SOURCE,
        engines: { actjs: '^9.0.0' },
      }),
    ).toThrow(IncompatibleEngine);
  });

  it('accepts engines.actjs that does satisfy the server', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Counter'),
        version: asVersion('1.0.0'),
        source: VALID_SOURCE,
        engines: { actjs: '>=0.1.0' },
      }),
    ).not.toThrow();
  });

  it('rejects source with a syntax error', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Broken'),
        version: asVersion('1.0.0'),
        source: 'class { not valid (',
      }),
    ).toThrow(SyntaxInvalid);
  });
});

describe('publishClass — driver integration', () => {
  it('stores the source and emits an audit entry', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const { sha256 } = await publishClass(driver, {
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      source: VALID_SOURCE,
      deps: { Item: '^1.0.0' },
      engines: { actjs: '>=0.1.0' },
    });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const got = await driver.getClassSource(asClassName('Cart'), asVersion('1.0.0'));
    expect(got).not.toBeNull();
    expect(got!.toString('utf8')).toBe(VALID_SOURCE);
    const audit = driver.auditEntries();
    expect(audit.map((e) => e.action)).toEqual(['class.published']);
    expect(audit[0]?.target).toBe('Cart@1.0.0');
    await driver.close();
  });

  it('refuses to overwrite an existing version', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await publishClass(driver, {
      name: asClassName('Cart'),
      version: asVersion('1.0.0'),
      source: VALID_SOURCE,
    });
    await expect(
      publishClass(driver, {
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `${VALID_SOURCE} // different`,
      }),
    ).rejects.toBeInstanceOf(VersionAlreadyPublishedError);
    await driver.close();
  });

  it('records floating + eventSourced flags', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await publishClass(driver, {
      name: asClassName('Ledger'),
      version: asVersion('1.0.0'),
      source: VALID_SOURCE,
      eventSourced: true,
    });
    const list = await driver.listClassVersions(asClassName('Ledger'));
    expect(list[0]?.eventSourced).toBe(true);
    expect(list[0]?.floating).toBe(false);
    await driver.close();
  });
});
