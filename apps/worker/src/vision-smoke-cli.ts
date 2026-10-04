import { runVisionSmoke } from './vision-smoke.js';
import { diagnosticCode } from './diagnostics.js';
void runVisionSmoke(process.argv.slice(2))
  .then((recognition) => {
    process.stdout.write(`${JSON.stringify(recognition)}\n`);
  })
  .catch((error) => {
    console.error(diagnosticCode(error, 'vision:smoke'));
    process.exitCode = 1;
  });
