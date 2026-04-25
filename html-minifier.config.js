/**
 * @type {import("html-minifier-next").MinifierOptions}
 */
const config = {
	collapseWhitespace: true,
	removeComments: true,
	minifyJS: true,
	minifyCSS: true,
	minifySVG: true,
};
module.exports = config;