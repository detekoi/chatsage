import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node,
                ...globals.jest,
            },
        },
        rules: {
            // ignoreRestSiblings covers the "omit these keys" idiom: destructuring a
            // property purely to keep it out of a `...rest` that gets forwarded on.
            // Deleting such a name would silently change what the rest spread carries.
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_|^e$|^err$|^error$', ignoreRestSiblings: true }],
            'no-console': 'off',
            'no-useless-assignment': 'warn',
            'preserve-caught-error': 'off',
        },
    },
];
