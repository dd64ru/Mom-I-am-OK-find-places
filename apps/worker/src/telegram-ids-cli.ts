import { runTelegramIds } from './telegram-ids.js';
import { diagnosticCode } from './diagnostics.js';
const controller = new AbortController();
const stop = () => {
  controller.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function main() {
  if (process.argv.length !== 2) throw new Error('unexpected_arguments');
  await runTelegramIds((metadata) => {
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  }, controller.signal);
}
void main()
  .catch((error) => {
    console.error(diagnosticCode(error, 'telegram:ids'));
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
