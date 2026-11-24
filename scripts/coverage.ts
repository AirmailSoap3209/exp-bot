/** Prints the coverage report without Discord:  npm run coverage */
import { loadCatalogue } from '../src/tasks/catalogue.js';
import { buildCoverage, formatCoverageText } from '../src/tasks/coverage.js';

console.log(formatCoverageText(buildCoverage(loadCatalogue())));
