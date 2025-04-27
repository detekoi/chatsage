#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const SOURCE_DIR = '/Users/henry/Dev/twitch-knowledge-bot';
const TARGET_DIR = '/Users/henry/Dev/gemini';

// Directories to exclude (hidden folders and large directories)
const EXCLUDED_DIRS = [
    '.git',
    'node_modules',
    '.vscode',
    '.idea',
    '.DS_Store'
];

// Ensure target directory exists
if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
}

// Clean target directory
console.log(`Cleaning target directory: ${TARGET_DIR}`);
const targetContents = fs.readdirSync(TARGET_DIR);
for (const item of targetContents) {
    const itemPath = path.join(TARGET_DIR, item);
    if (fs.lstatSync(itemPath).isDirectory()) {
        fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
        fs.unlinkSync(itemPath);
    }
}

// Copy function that excludes specified directories
function copyRecursive(source, target) {
    const stats = fs.statSync(source);
    
    if (stats.isDirectory()) {
        const basename = path.basename(source);
        
        // Skip excluded directories
        if (EXCLUDED_DIRS.includes(basename) || basename.startsWith('.')) {
            return;
        }
        
        if (!fs.existsSync(target)) {
            fs.mkdirSync(target, { recursive: true });
        }
        
        const entries = fs.readdirSync(source);
        for (const entry of entries) {
            const sourcePath = path.join(source, entry);
            const targetPath = path.join(target, entry);
            copyRecursive(sourcePath, targetPath);
        }
    } else if (stats.isFile()) {
        fs.copyFileSync(source, target);
    }
}

// Perform the copy
console.log(`Copying from ${SOURCE_DIR} to ${TARGET_DIR}`);
copyRecursive(SOURCE_DIR, TARGET_DIR);

console.log('Migration complete!');