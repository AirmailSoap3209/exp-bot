import { loadCatalogue, type Catalogue } from './catalogue.js';

/** Loaded once at startup: an invalid catalogue stops the bot instead of giving wrong answers. */
export const catalogue: Catalogue = loadCatalogue();
