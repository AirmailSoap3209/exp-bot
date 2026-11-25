import { loadCombos, type Combo } from '../combos/combos.js';
import { loadRates, type RateBook } from '../estimate/rates.js';
import { loadCatalogue, type Catalogue } from './catalogue.js';

/** Loaded once at startup: invalid tasks, rates or combos stop the bot instead of giving wrong answers. */
export const catalogue: Catalogue = loadCatalogue();
export const rateBook: RateBook = loadRates();
export const combos: Combo[] = loadCombos(catalogue, rateBook);
