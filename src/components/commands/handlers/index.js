// src/components/commands/handlers/index.js
import logger from '../../../lib/logger.js';

// Import individual command handlers (we will create these files later)
// Core Bot Commands
// import help from './help.js';
import ping from './ping.js'; // Let's create ping first as a simple example
import search from './search.js';
// import about from './about.js';

// Stream Context Commands
// import game from './game.js';
// import info from './info.js';

// Knowledge & LLM Commands
// import ask from './ask.js';
// import fact from './fact.js';
// import search from './search.js'; // Note: command was !wiki in description? Using !search for consistency.
// import explain from './explain.js';

// Context Management Commands (Likely Mod/Broadcaster only)
// import context from './contextCmd.js'; // Renamed to avoid JS keyword clash
// import remember from './remember.js';
// import forget from './forget.js';
// import summary from './summary.js';
// import reset from './reset.js';

// Moderator/Broadcaster Commands
// import enable from './enable.js';
// import disable from './disable.js';
// import cooldown from './cooldown.js';
// import setthreshold from './setthreshold.js';


logger.debug('Loading command handlers...');

// Structure: { commandName: { execute: function, permission: string, description: string }, ... }
const commandHandlers = {
    // --- Core Bot Commands ---
    // help: help, // Define help command
    // commands: help, // Alias !commands to !help handler
    ping: ping,
    search: search,
    // about: about,

    // --- Stream Context Commands ---
    // game: game,
    // info: info,

    // --- Knowledge & LLM Commands ---
    // ask: ask,
    // fact: fact,
    // search: search, // !search alias
    // wiki: search,   // !wiki alias (if desired)
    // explain: explain,

    // --- Context Management Commands ---
    // context: context, // !context command (for mods)
    // remember: remember, // !remember command (for mods)
    // forget: forget,   // !forget command (for mods)
    // summary: summary, // !summary command (for mods)
    // reset: reset,   // !reset command (for mods)

    // --- Moderator/Broadcaster Commands ---
    // enable: enable,
    // disable: disable,
    // cooldown: cooldown,
    // setthreshold: setthreshold,
};

// Log loaded commands dynamically
const loadedCommands = Object.keys(commandHandlers);
if (loadedCommands.length > 0) {
    logger.debug(`Successfully loaded command handlers for: ${loadedCommands.join(', ')}`);
} else {
     logger.warn('No command handlers were imported or mapped in handlers/index.js');
}

export default commandHandlers;