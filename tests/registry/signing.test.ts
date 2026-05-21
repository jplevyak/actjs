/**
 * Tests for the signing-key registry + publish-time signing path.
 */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MemorySigningKeyRegistry,
  publishClass,
  SignatureInvalid,
  SignatureRequired,
  signingMessage,
  SigningKeyNotFound,
} from '../../src/registry/index.js';
import { MemoryStorageDriver } from '../../src/storage/memory.js';
import { asClassName, asVersion } from '../../src/types/index.js';

const SOURCE = `
class Note extends actjs.Actor {
  constructor() { super(); }
}
return Note;
`;

interface KeyPairWithPem {
  kid: string;
  publicKeyPem: string;
  sign(message: Buffer): Buffer;
}

function makeKey(kid: string): KeyPairWithPem {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    kid,
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    sign(message: Buffer): Buffer {
      return nodeSign(null, message, privateKey);
    },
  };
}

describe('MemorySigningKeyRegistry', () => {
  it('add + get + list', async () => {
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('k1');
    await reg.add(k.kid, k.publicKeyPem);
    const got = await reg.get('k1');
    expect(got?.kid).toBe('k1');
    expect(got?.algorithm).toBe('EdDSA');
    expect((await reg.list()).length).toBe(1);
  });

  it('rejects duplicate kid', async () => {
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('dup');
    await reg.add(k.kid, k.publicKeyPem);
    await expect(reg.add(k.kid, k.publicKeyPem)).rejects.toThrow(/already registered/);
  });

  it('revoke marks the key and rejects future verifies', async () => {
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('k2');
    await reg.add(k.kid, k.publicKeyPem);
    await reg.revoke(k.kid);
    const got = await reg.get(k.kid);
    expect(got?.revokedAt).toBeTypeOf('number');
    const message = Buffer.from('hello', 'utf8');
    const sig = k.sign(message);
    const v = await reg.verify({ kid: k.kid, signature: sig, message });
    expect(v.ok).toBe(false);
  });

  it('revoke of an unknown kid throws', async () => {
    const reg = new MemorySigningKeyRegistry();
    await expect(reg.revoke('missing')).rejects.toBeInstanceOf(SigningKeyNotFound);
  });

  it('verify: valid signature returns ok', async () => {
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('k3');
    await reg.add(k.kid, k.publicKeyPem);
    const message = Buffer.from('the payload', 'utf8');
    const sig = k.sign(message);
    const v = await reg.verify({ kid: k.kid, signature: sig, message });
    expect(v.ok).toBe(true);
  });

  it('verify: tampered signature returns not-ok', async () => {
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('k4');
    await reg.add(k.kid, k.publicKeyPem);
    const message = Buffer.from('hi', 'utf8');
    const sig = k.sign(message);
    sig[0] ^= 0xff;
    const v = await reg.verify({ kid: k.kid, signature: sig, message });
    expect(v.ok).toBe(false);
  });
});

describe('publishClass with signing', () => {
  it('accepts a signed publish and records the signedBy', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('release-key');
    await reg.add(k.kid, k.publicKeyPem);

    const source = Buffer.from(SOURCE, 'utf8');
    const sha = (await import('node:crypto')).createHash('sha256').update(source).digest('hex');
    const message = signingMessage(sha, asClassName('Note'), asVersion('1.0.0'));
    const sig = k.sign(message);

    const result = await publishClass(
      driver,
      {
        name: asClassName('Note'),
        version: asVersion('1.0.0'),
        source,
        signature: { kid: k.kid, signature: sig },
      },
      { signingKeys: reg },
    );
    expect(result.signedBy).toBe(k.kid);
    const audit = driver.auditEntries();
    expect(audit.some((e) => e.action === 'class.signed')).toBe(true);
  });

  it('rejects an unsigned publish when requireSignedClasses is true', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    await expect(
      publishClass(
        driver,
        {
          name: asClassName('Note'),
          version: asVersion('1.0.0'),
          source: SOURCE,
        },
        { requireSignedClasses: true },
      ),
    ).rejects.toBeInstanceOf(SignatureRequired);
  });

  it('rejects a signature from a non-registered kid', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const reg = new MemorySigningKeyRegistry();
    const known = makeKey('known');
    await reg.add(known.kid, known.publicKeyPem);
    const evil = makeKey('evil');

    const source = Buffer.from(SOURCE, 'utf8');
    const sha = (await import('node:crypto')).createHash('sha256').update(source).digest('hex');
    const sig = evil.sign(signingMessage(sha, asClassName('Note'), asVersion('1.0.0')));

    await expect(
      publishClass(
        driver,
        {
          name: asClassName('Note'),
          version: asVersion('1.0.0'),
          source,
          signature: { kid: 'unknown', signature: sig },
        },
        { signingKeys: reg },
      ),
    ).rejects.toBeInstanceOf(SignatureInvalid);
  });

  it('rejects a signature from a revoked kid', async () => {
    const driver = new MemoryStorageDriver();
    await driver.init();
    const reg = new MemorySigningKeyRegistry();
    const k = makeKey('to-revoke');
    await reg.add(k.kid, k.publicKeyPem);
    await reg.revoke(k.kid);

    const source = Buffer.from(SOURCE, 'utf8');
    const sha = (await import('node:crypto')).createHash('sha256').update(source).digest('hex');
    const sig = k.sign(signingMessage(sha, asClassName('Note'), asVersion('1.0.0')));

    await expect(
      publishClass(
        driver,
        {
          name: asClassName('Note'),
          version: asVersion('1.0.0'),
          source,
          signature: { kid: k.kid, signature: sig },
        },
        { signingKeys: reg },
      ),
    ).rejects.toBeInstanceOf(SignatureInvalid);
  });
});
