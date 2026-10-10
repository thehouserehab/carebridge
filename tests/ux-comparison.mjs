// Compatibility entry point. Automated milliseconds/fixed transition counts
// are intentionally no longer generated as usability evidence.
import { runStudy } from '../scripts/p0-study.mjs';
await runStudy(process.argv.slice(2));
