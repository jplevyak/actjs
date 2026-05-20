import { describe, expect, it } from 'vitest';

import { ForbiddenImport, validatePublish } from '../../src/registry/index.js';
import { asClassName, asVersion } from '../../src/types/index.js';

const BASE = `
class Cart extends actjs.Actor {
  constructor() { super(); }
}
return Cart;
`;

describe('publisher — forbidden imports', () => {
  it('accepts source with no imports', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: BASE,
      }),
    ).not.toThrow();
  });

  it("rejects `import x from 'y'`", () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `import fs from 'fs';\n${BASE}`,
      }),
    ).toThrow(ForbiddenImport);
  });

  it("rejects `import { x } from 'y'`", () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `import { readFileSync } from 'node:fs';\n${BASE}`,
      }),
    ).toThrow(ForbiddenImport);
  });

  it('rejects `export` statements', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `${BASE}\nexport default Cart;`,
      }),
    ).toThrow(ForbiddenImport);
  });

  it('ignores commented-out import lines', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `// import fs from 'fs';\n${BASE}`,
      }),
    ).not.toThrow();
  });

  it('ignores block-commented-out import lines', () => {
    expect(() =>
      validatePublish({
        name: asClassName('Cart'),
        version: asVersion('1.0.0'),
        source: `/*\nimport fs from 'fs';\n*/\n${BASE}`,
      }),
    ).not.toThrow();
  });
});
