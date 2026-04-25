import path from 'node:path';
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { minify_sync as terserMinifySync } from 'terser';
import { minify as htmlMinify } from 'html-minifier-next';
import htmlMinifyConfig from '../html-minifier.config.js';

const __filename = fileURLToPath(import.meta.url);
console.error(`__filename:`, __filename);

const __dirname = path.dirname(__filename);
console.error(`__dirname:`, __dirname);

const repoRoot = path.resolve(__dirname, '..');
console.error(`repoRoot:`, repoRoot);

const distRoot = path.join(repoRoot, 'dist');
console.error(`distRoot:`, distRoot);

execSync(`npm run prepare:terser:config`);
const terserConfig = JSON.parse(readFileSync('terser.config.json', 'utf8'));
console.log(`Fetched terser.config.json:`, terserConfig);

console.log(`Fetched html-minifier.config.js:`, htmlMinifyConfig);

const BROWSERS = { CHROME: 'chrome', FIREFOX: 'firefox' };

const targets = {
	[BROWSERS.CHROME]: {
		sourceDir: path.join(repoRoot, 'Chrome'),
		outputDir: path.join(distRoot, 'Chrome'),
	},
	[BROWSERS.FIREFOX]: {
		sourceDir: path.join(repoRoot, 'FireFox'),
		outputDir: path.join(distRoot, 'FireFox'),
	},
};

const requestedTarget = (process.argv[2] || 'all').toLowerCase();
const selectedTargets =
	requestedTarget === 'all' ? Object.keys(targets) : requestedTarget in targets ? [requestedTarget] : null;

if (!selectedTargets) {
	console.error(`Unknown target "${requestedTarget}". Use one of: all, chrome, firefox.`);
	process.exit(1);
}

mkdirSync(distRoot, { recursive: true });

const buildSummary = [];

for (const targetName of selectedTargets) {
	console.log('targetName:', targetName);
	const { sourceDir, outputDir } = targets[targetName];
	console.log('sourceDir:', sourceDir);
	console.log('outputDir:', outputDir);

	const manifestPath = path.join(sourceDir, 'manifest.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const version = manifest.version.split('.').join('');

	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(outputDir, { recursive: true });
	// cpSync(sourceDir, outputDir, { recursive: true });

	const filesPaths = readdirSync(sourceDir, { recursive: false });
	for (const filePath of filesPaths) {
		const inFilePath = path.join(sourceDir, filePath);
		const outFilePath = path.join(outputDir, filePath);
		const minifiedPath = await minify(inFilePath, outFilePath);
		if (minifiedPath) {
			console.log(`Minified:`, inFilePath, outFilePath);
		// } else if (minifiedPath === undefined) {
		// 	console.log(`Folder Skipped:`, inFilePath);
		} else {
			console.log(`Minified Failed for:`, inFilePath);
		}
	}

	buildSummary.push({
		target: targetName,
		name: manifest.name,
		version,
		sourceDir: path.relative(repoRoot, sourceDir),
		outputDir: path.relative(repoRoot, outputDir),
		archiveName: `ScriptPatcher.v${version}.${targetName}.zip`,
	});

	console.log(
		`Built ${targetName} extension from ${path.relative(
			repoRoot,
			sourceDir,
		)} to ${path.relative(repoRoot, outputDir)}.`,
	);
	console.log(``);
}

writeFileSync(path.join(distRoot, 'build-manifest.json'), JSON.stringify(buildSummary, null, 2) + '\n', 'utf8');

/**
 * @param {string} inFilePath
 * @param {string} outFilePath
 * @returns {string | undefined | false}
 * - `outFilePath` if minify was successful or Folder was copied
 * - `false` if minified failed
 */
async function minify(inFilePath, outFilePath) {
	const ext = path.extname(inFilePath);
	// if (!ext) {
	// 	return undefined;
	// }
	let sourceCode = '',
		minifiedCode = '',
		copyOnly = false;
	switch (ext) {
		case '.js':
			sourceCode = readFileSync(inFilePath, 'utf8');
			minifiedCode = minifyJS(sourceCode);
			break;
		case '.html':
			sourceCode = readFileSync(inFilePath, 'utf8');
			minifiedCode = await minifyHTML(sourceCode);
			break;
		default:
			cpSync(inFilePath, outFilePath, { recursive: true });
			copyOnly = true;
	}
	if (minifiedCode) {
		writeFileSync(outFilePath, minifiedCode, 'utf8');
		return outFilePath;
	}
	if (copyOnly) {
		return outFilePath;
	}
	return false;
}

/**
 * @param {string} code
 */
function minifyJS(code) {
	return terserMinifySync(code, terserConfig).code;
}

/**
 * @param {string} code
 */
async function minifyHTML(code) {
	return await htmlMinify(code, terserConfig);
}
