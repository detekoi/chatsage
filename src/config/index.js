// src/config/index.js

/**
 * Re-exports the loaded configuration object.
 * This provides a clean entry point for accessing configuration
 * throughout the application.
 *
 * Usage: import config from '../config/index.js';
 *  (or often simplified by module resolution as: import config from 'src/config'; depending on setup)
 */
import config from './loader.js';

export default config;