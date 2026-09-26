import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import strykerCore from '../stryker.core.config.mjs';
import stryker from '../stryker.config.mjs';
import vitestConfig from '../vitest.config.js';
import vitestCore from '../vitest.core.config.js';

/**
 * The copy of spec-core under src/vendor/ is spec-core's, byte for byte
 * (spec-core ADR-0001). An edit made here instead of there would drift from
 * every other tool's copy, so each file is hashed again and compared with the
 * record the copy was made with. To change a vendored file, change spec-core
 * and run its `node scripts/vendor.mjs --into <this repository>`.
 */

const ROOT = 'src/vendor/spec-core';

interface VendorRecord {
  readonly source: string;
  readonly commit: string | null;
  readonly modules: Readonly<Record<string, { readonly files: Readonly<Record<string, string>> }>>;
}

const record = JSON.parse(readFileSync(`${ROOT}/VENDOR.json`, 'utf8')) as VendorRecord;

const sha256 = (path: string): string => `sha256-${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

describe('the vendored spec-core', () => {
  it('names the commit it was copied from', () => {
    expect(record.source).toBe('https://github.com/DescentVTT/spec-core');
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('holds the modules spec-brief uses, and the ones they import', () => {
    expect(Object.keys(record.modules).sort()).toEqual(['markdown', 'path', 'pattern', 'text']);
  });

  for (const [module, { files }] of Object.entries(record.modules)) {
    it(`${module}: every file is the one that was copied`, () => {
      const edited = Object.entries(files).filter(([name, hash]) => sha256(`${ROOT}/${module}/${name}`) !== hash);
      expect(edited.map(([name]) => name)).toEqual([]);
    });

    it(`${module}: holds no file the record does not name`, () => {
      const present = readdirSync(`${ROOT}/${module}`).sort();
      expect(present).toEqual(Object.keys(files).sort());
    });
  }

  it("ships spec-core's licence with the compiled copies", () => {
    // The package carries dist/vendor/spec-core/**, spec-core's code under MIT,
    // so its notice goes in the tarball beside them.
    expect(readFileSync(`${ROOT}/LICENSE`, 'utf8')).toMatch(/^MIT License\n/);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain(`${ROOT}/LICENSE`);
    expect(readdirSync(ROOT).sort()).toEqual(['LICENSE', 'README.md', 'VENDOR.json', ...Object.keys(record.modules)].sort());
  });

  it('is measured in spec-core, not in this repository', () => {
    // Its mutation sweep and its oracle are spec-core's; counted here, the copy
    // would pad or dilute a score about code this repository owns.
    expect(stryker.mutate).toContain('!src/vendor/**');
    expect(strykerCore.mutate).toContain('!src/vendor/**');
    expect(vitestConfig.test?.coverage?.exclude).toContain('src/vendor/**');
    // This file reads the disk, so it stays out of the unit suite.
    expect(vitestCore.test?.exclude).toContain('tests/vendor.test.ts');
  });
});
