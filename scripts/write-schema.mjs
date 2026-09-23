// Writes schema.json from the schema the loader validates against, so the two
// cannot drift. tests/config.test.ts fails when the committed file is stale.
import { writeFileSync } from 'node:fs';

import { configJsonSchema } from '../dist/config.js';

writeFileSync(new URL('../schema.json', import.meta.url), `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
