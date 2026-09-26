#!/usr/bin/env node
import { main } from "../src/cli.js";
import { WorkslotError } from "../src/errors.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    if (err instanceof WorkslotError) {
      console.error(err.message);
      process.exit(err.status ?? 1);
    }
    console.error(err);
    process.exit(1);
  },
);
