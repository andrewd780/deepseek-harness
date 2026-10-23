import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Imported first by every spec that composes the plugin: the plugin resolves
// its Harness home from DSH_HOME when the composition names none, so no test
// reads or writes the operator's ~/.dsh.
process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'dsh-self-improve-home-'))
