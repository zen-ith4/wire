// tests/groups/_env-3c.mjs
//
// STEP 3C test environment. Must be imported BEFORE ./ _scenario.mjs (which
// loads config/constants.js, and therefore config/multer.js, and therefore
// reads these variables ONCE).
//
// It does two things:
//  1. points GROUP_UPLOAD_DIR at a directory that does NOT exist yet, so the
//     server has to create it - that is exactly the "first-ever upload into a
//     fresh tree" case of STEP 3C item 2(a);
//  2. lowers GROUP_UPLOAD_MAX_MB to 1 MB so the size-cap test can send a
//     1 MB file without moving 50 MB around.

import { TEST_ROOT } from './_env.mjs';

import fs from 'node:fs';
import path from 'node:path';

process.env.GROUP_UPLOAD_DIR = path.join(TEST_ROOT, 'group-uploads-3c');
process.env.GROUP_UPLOAD_MAX_MB = '1';

// The fresh directory: removed here, on purpose.
fs.rmSync(process.env.GROUP_UPLOAD_DIR, { recursive: true, force: true });
