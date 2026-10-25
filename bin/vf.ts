#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { main } from '../src/cli/main.ts';

main(process.argv.slice(2)).catch((err: Error) => {
  process.stderr.write(`vf: ${err.message}\n`);
  process.exit(1);
});
