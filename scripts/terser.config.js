/**
 * Use this file to generate .json file for terse as terser do not support .js option file
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @type {import("terser").MinifyOptions}
 */
const config = {
	compress: true,
	ecma: 2020,
	mangle: true,
	sourceMap: false,
};

const __filename = fileURLToPath(import.meta.url);
console.error(`__filename:`, __filename);

const __dirname = path.dirname(__filename);
console.error(`__dirname:`, __dirname);

const repoRoot = path.resolve(__dirname, '..');
console.error(`repoRoot:`, repoRoot);

const outFilePath = path.join(repoRoot, 'terser.config.json');
writeFileSync(outFilePath, JSON.stringify(config, null, '\t') + '\n', 'utf8');
console.error(`File Written:`, outFilePath);
