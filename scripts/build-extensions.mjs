import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'dist');

const BROWSERS = { CHROME: 'chrome', FIREFOX: 'firefox' };

const targets = {
	[BROWSERS.CHROME]: {
		sourceDir: path.join(repoRoot, 'Chrome'),
		outputDir: path.join(distRoot, 'chrome'),
	},
	[BROWSERS.FIREFOX]: {
		sourceDir: path.join(repoRoot, 'FireFox'),
		outputDir: path.join(distRoot, 'firefox'),
	},
};

const requestedTarget = (process.argv[2] || 'all').toLowerCase();
const selectedTargets =
	requestedTarget === 'all' ? Object.keys(targets) : requestedTarget in targets ? [requestedTarget] : null;

if (!selectedTargets) {
	console.error(`Unknown target "${requestedTarget}". Use one of: all, chrome, firefox.`);
	process.exit(1);
}

await mkdir(distRoot, { recursive: true });

const buildSummary = [];

for (const targetName of selectedTargets) {
	const { sourceDir, outputDir } = targets[targetName];
	const manifestPath = path.join(sourceDir, 'manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	const version = manifest.version;

	await rm(outputDir, { recursive: true, force: true });
	await mkdir(outputDir, { recursive: true });
	await cp(sourceDir, outputDir, { recursive: true });

	buildSummary.push({
		target: targetName,
		name: manifest.name,
		version,
		sourceDir: path.relative(repoRoot, sourceDir),
		outputDir: path.relative(repoRoot, outputDir),
		archiveName: `script-patcher-${targetName}-v${version}.zip`,
	});

	console.log(
		`Built ${targetName} extension from ${path.relative(
			repoRoot,
			sourceDir,
		)} to ${path.relative(repoRoot, outputDir)}.`,
	);
}

await writeFile(path.join(distRoot, 'build-manifest.json'), JSON.stringify(buildSummary, null, 2) + '\n', 'utf8');
