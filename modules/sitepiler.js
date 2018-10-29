const _ = require('lodash');
const chokidar = require('chokidar');
const less = require('less');
const livereload = require('livereload');
const lognext = require('lognext');
const fs = require('fs-extra');
const path = require('path');
const Q = require('q');

const ConfigHelper = require('./configHelper');
const ContextExtensions = require('./contextExtensions');
const Directory = require('./classes/directory');
const fileLoader = require('./fileLoader');
const Page = require('./classes/page');
const PageData = require('./classes/pageData');
const renderer = require('./renderer');


const log = new lognext('Sitepiler');
const watcherlog = new lognext('watcher');



class Sitepiler {
	constructor(config) {
		log.setLogLevel(global.logLevel);

		// Sitepiler configuration
		this.config = config;

		this.initCompileProps();

		// Livereload
		if (this.config.cliopts.livereload && this.config.cliopts.local) {
			this.livereloadServer = livereload.createServer({
				port: this.config.cliopts.livereloadPort	
			}, 
			() => log.info(`Livereload accepting connections on port ${this.config.cliopts.livereloadPort}`));

			let watchPaths = [];
			watchPaths.push(path.resolve(this.config.settings.stages.compile.outputDirs.content));
			this.livereloadServer.watch(watchPaths);

			// Monitor sources to trigger individual page rebuilds
			watchPaths = [];
			this.config.settings.stages.compile.contentDirs.forEach((contentDir) => watchPaths.push(contentDir.source));
			this.sourceWatcher = chokidar.watch(watchPaths, {
				awaitWriteFinish: true,
				ignoreInitial: true
			});
			this.sourceWatcher.on('all', sourceWatcherEvent.bind(this));

			// Monitor templates and styles to trigger full rebuild
			watchPaths = [];
			this.config.settings.stages.compile.templateDirs.layouts.forEach((templateDir) => watchPaths.push(templateDir));
			this.config.settings.stages.compile.templateDirs.partials.forEach((templateDir) => watchPaths.push(templateDir));
			this.config.settings.stages.compile.styleDirs.forEach((styleDir) => watchPaths.push(styleDir.source));
			this.templateWatcher = chokidar.watch(watchPaths, {
				awaitWriteFinish: true,
				ignoreInitial: true
			});
			this.templateWatcher.on('all', templateWatcherEvent.bind(this));

		}
	}

	// These props should be cleared when a full recompile is triggered
	initCompileProps() {
		// Uncompiled templates
		this.templateSource = {
			layouts: {},
			partials: {}
		};

		// Context for template execution
		this.context = {
			config: this.config,
			data: this.context ? this.context.data || {} : {},
			content: {},
			sitemap: {
				dirs: {},
				pages: []
			}
		};

		// Uncompiled CSS/LESS
		this.styleSource = {};
	}

	gatherData() {
		const deferred = Q.defer();

		try {
			log.writeBox('Stage: gather data');

			// Load data files
			const tempData = {};
			this.config.settings.stages.data.dataDirs.forEach((dataDir) => {
				fileLoader.loadFiles(dataDir, tempData, [ fileLoader.filters.JSON, fileLoader.filters.YAML ]);
			});

			// Copy data to context, strip extension from filename key
			_.forOwn(tempData, (value, key) => {
				this.context.data[key.substring(0, key.length - path.extname(key).length)] = value;
			});

			// Complete stage
			deferred.resolve();
		} catch(err) {
			deferred.reject(err);
		}

		return deferred.promise;
	}

	compile() {
		const deferred = Q.defer();

		try {
			log.writeBox('Stage: compile');
			let compileStartMs = Date.now();

			// Clear old data
			this.initCompileProps();

			// TODO: separate the template loading/compiling so that this module can be used without running a full compile
			// Load templates
			let startMs = Date.now();
			this.config.settings.stages.compile.templateDirs.layouts.forEach((dataDir) => {
				fileLoader.loadFiles(dataDir, this.templateSource.layouts, [ fileLoader.filters.DOT ], true);
			});
			this.config.settings.stages.compile.templateDirs.partials.forEach((dataDir) => {
				fileLoader.loadFiles(dataDir, this.templateSource.partials, [ fileLoader.filters.DOT ], true);
			});
			log.verbose(`Templates loaded in ${Date.now() - startMs}ms`);

			// Load content
			startMs = Date.now();
			let tempSources = {};
			this.config.settings.stages.compile.contentDirs.forEach((sourceDir) => {
				let targetDir = tempSources;
				if (sourceDir.dest !== '') {
					sourceDir.dest.split('/').forEach((d) => {
						if (!targetDir[d]) targetDir[d] = {};
						targetDir = targetDir[d];
					});
				}
				fileLoader.loadFiles(sourceDir.source, targetDir, [ fileLoader.filters.MARKDOWN ], true);
			});
			log.verbose(`Content loaded in ${Date.now() - startMs}ms`);

			// Process page sources
			this.context.sitemap = processSources(tempSources);
			this.context.sitemap.analyze();

			// Load styles
			startMs = Date.now();
			this.config.settings.stages.compile.styleDirs.forEach((sourceDir) => {
				let targetDir = this.styleSource;
				if (sourceDir.dest !== '') {
					sourceDir.dest.split('/').forEach((d) => {
						if (!targetDir[d]) targetDir[d] = {};
						targetDir = targetDir[d];
					});
				}
				fileLoader.loadFiles(sourceDir.source, targetDir, [ fileLoader.filters.STYLES ], true);
			});
			log.verbose(`Styles loaded in ${Date.now() - startMs}ms`);

			// Process styles
			processStyles(this.styleSource, this.config.settings.stages.compile.outputDirs.styles);

			// Process static content
			startMs = Date.now();
			this.config.settings.stages.compile.staticDirs.forEach((sourceDir) => {
				const targetDir = path.join(this.config.settings.stages.compile.outputDirs.static, sourceDir.dest);
				log.info(`Copying static files from ${sourceDir.source} to ${targetDir}`);
				fs.copySync(sourceDir.source, targetDir);
			});
			log.verbose(`Static files copied in ${Date.now() - startMs}ms`);


			// Compile templates so they can be used
			startMs = Date.now();
			renderer.compileTemplates(this.templateSource.layouts, renderer.templates.layouts, this.context);
			renderer.compileTemplates(this.templateSource.partials, renderer.templates.partials, this.context);
			log.verbose(`Templates compiled in ${Date.now() - startMs}ms`);

			// Build content pages using templates
			startMs = Date.now();
			this.context.sitemap.renderPages(this.context);
			log.verbose(`Built content files in ${Date.now() - startMs}ms`);

			// Write content pages to disk
			startMs = Date.now();
			writeContent(this.context.sitemap, this.config.settings.stages.compile.outputDirs.content);
			log.verbose(`Content written in ${Date.now() - startMs}ms`);

			// Complete stage
			log.verbose(`Compile stage completed in ${Date.now() - compileStartMs}ms`);

			deferred.resolve();
		} catch(err) {
			deferred.reject(err);
		}

		return deferred.promise;
	}

	publish() {
		const deferred = Q.defer();

		try {
			log.writeBox('Stage: publish');

			// TODO

			deferred.resolve();
		} catch(err) {
			deferred.reject(err);
		}

		return deferred.promise;
	}

	render(content) {
		//TODO: is this right? This seems leftover, should be pageData instead of string content.
		content.body = renderer.renderContent(content, ContextExtensions.fromContext(this.context), renderer.templates.layouts);
		return content;
	}

	prepareOutputFileName(inputFilename) {
		return renderer.stripExtension(inputFilename, '.md');
	}
}



module.exports = Sitepiler;



function processSources(sources, directory = Directory.fromPath('/')) {
	_.forOwn(sources, (value, key) => {
		if (typeof(value) === 'object') {
			directory.dirs[key] = Directory.fromPath(path.join(directory.path, key));
			processSources(value, directory.dirs[key], directory.path);
		} else {
			const wasAdded = directory.addPage(Page.create(value, path.join(directory.path, key)));
			if (!wasAdded)
				log.warn('Failed to add page to directory structure! Page path: ' + path.join(directory.path, key));
		}
	});
	return directory;
}

function processStyles(styleSource, outputDir) {
	/*
	 * TODO: not sure if reading every file is the best way to process LESS.
	 * There is some indication that the LESS render function can resolve 
	 * external files automatically. Need to determine best approach.
	 * http://lesscss.org/usage/#programmatic-usage
	 */

	_.forOwn(styleSource, (value, key) => {
		if (typeof(value) === 'object') {
			processStyles(value, path.join(outputDir, key));
			return;
		}

		if (key.toLowerCase().endsWith('less')) {
			log.verbose(`Rendering LESS file ${key}`);
			less.render(value)
				.then((output) => {
					const outPath = path.join(outputDir, key.replace('.less', '.css'));
					log.verbose('Writing less file: ', outPath);
					fs.ensureDirSync(outputDir);
					fs.writeFileSync(outPath, output.css, 'utf-8');
				})
				.catch((err) => log.error(err));
		} else {
			log.verbose('Writing file: ', path.join(outputDir, key));
			fs.ensureDirSync(outputDir);
			fs.writeFileSync(path.join(outputDir, key), value, 'utf-8');
		}

	});
}

// Expects to have context bound to a sitepiler instance
function templateWatcherEvent(evt, filePath) {
	watcherlog.verbose(`(template) ${evt} >> ${filePath}`);

	// Skip if disabled
	if (this.config.settings.templateChangeRebuildQuietSeconds < 0) return;

	// Clear pending timer
	if (this.templateWatcherRebuiltTimeout) clearTimeout(this.templateWatcherRebuiltTimeout);

	// Set new timer
	watcherlog.info(`Triggering recompile in ${this.config.settings.templateChangeRebuildQuietSeconds} seconds...`);
	this.templateWatcherRebuiltTimeout = setTimeout(this.compile.bind(this), this.config.settings.templateChangeRebuildQuietSeconds * 1000);
}

// Expects to have context bound to a sitepiler instance
function sourceWatcherEvent(evt, filePath) {
	watcherlog.verbose(`(source) ${evt} >> ${filePath}`);

	// Find content dir
	let contentDir;
	this.config.settings.stages.compile.contentDirs.some((c) => {
		if (filePath.startsWith(c.source)) {
			contentDir = c;
			return true;
		}
	});
	if (!contentDir)
		return watcherlog.error(`Failed to find content dir for source ${filePath}`);

	// Determine paths
	const subdir = filePath.substring(contentDir.source.length + 1, filePath.length - path.basename(filePath).length);
	const relativePath = path.join(contentDir.dest, subdir);
	const destPath = path.join(this.config.settings.stages.compile.outputDirs.content, relativePath);

	// Generate content
	let content = fs.readFileSync(filePath, 'utf-8');
	const page = Page.create(content, path.join(relativePath, path.basename(filePath)));
	this.context.sitemap.addPage(page);
	page.render(this.context);

	// Write to file
	const contentObject = { pages: { }};
	contentObject.pages[page.filename] = page;
	writeContent(contentObject, destPath);
}

function writeContent(sitemap, outputDir) {
	_.forOwn(sitemap.pages, (page) => {
		log.verbose('Writing file: ', path.join(outputDir, page.filename));
		fs.ensureDirSync(outputDir);
		fs.writeFileSync(path.join(outputDir, page.filename), page.body, 'utf-8');
	});

	// Recurse dirs
	_.forOwn(sitemap.dirs, (dir, dirName) => {
		writeContent(dir, path.join(outputDir, dirName));
	});
}
