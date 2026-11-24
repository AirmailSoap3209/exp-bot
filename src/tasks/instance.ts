import { loadRates, type RateBook } from '../estimate/rates.js';
import { loadCatalogue, type Catalogue } from './catalogue.js';

/** Loaded once at startup: invalid tasks or rates stop the bot instead of giving wrong answers. */
export const catalogue: Catalogue = loadCatalogue();
export const rateBook: RateBook = loadRates();
