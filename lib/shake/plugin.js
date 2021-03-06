'use strict';

const HarmonyImportDependency =
    require('webpack/lib/dependencies/HarmonyImportDependency');

const shake = require('common-shake');
const Analyzer = shake.Analyzer;
const Graph = shake.Graph;

const root = require('../shake');
const ReplacementModule = root.ReplacementModule;
const GlobalBailout = root.GlobalBailout;
const ModuleBailout = root.ModuleBailout;

function State() {
  this.analyzer = new Analyzer();
  this.resources = new Set();
}

function ShakeParserPlugin(state) {
  this.state = state;
}

ShakeParserPlugin.prototype.apply = function apply(parser) {
  parser.plugin('program', (ast) => {
    const resource = parser.state.current.resource;
    this.state.analyzer.run(ast, resource);
    this.state.resources.add(resource);
  });
};

function ShakePlugin(options) {
  this.options = Object.assign({}, options);
}
module.exports = ShakePlugin;

ShakePlugin.prototype.apply = function apply(compiler) {
  compiler.plugin('compilation', (compilation, params) => {
    const imports = new Map();

    const state = new State();

    params.normalModuleFactory.plugin('parser', (parser, parserOptions) => {
      if (typeof parserOptions.commonjs !== 'undefined' &&
          !parserOptions.commonjs) {
        return;
      }

      parser.apply(new ShakeParserPlugin(state));
    });

    params.normalModuleFactory.plugin('create-module', (module) => {
      const issuer = module.resourceResolveData.context.issuer;
      if (issuer === null)
        return;
      state.analyzer.resolve(issuer, module.rawRequest, module.resource);
    });

    compilation.plugin('optimize-chunk-modules', (chunks, modules) => {
      // Global bailout
      if (!state.analyzer.isSuccess()) {
        if (this.options.onGlobalBailout)
          this.options.onGlobalBailout(state.analyzer.bailouts);

        state.analyzer.bailouts.forEach((bailout) => {
          const loc = `${bailout.source}:` +
              `${bailout.loc.start.line}:${bailout.loc.start.column}`;
          const reason = `${bailout.reason} at [${loc}]`;

          compilation.warnings.push(new GlobalBailout(bailout));
        });

        // TODO(indutny): print per-module warnings
        return;
      }

      const map = new Map();

      const mapModule = (module) => {
        if (map.has(module))
          return map.get(module);

        const res = this.mapModule(state, compilation, module);
        map.set(module, res);
        return res;
      };

      chunks.forEach((chunk) => {
        // TODO(indutny): reconsider it with more data in mind
        // Do not shake entry module
        if (chunk.entryModule)
          state.resources.delete(chunk.entryModule.resource);

        chunk.setModules(chunk.mapModules(mapModule));
      });

      compilation.modules = modules.map(mapModule);

      if (this.options.onGraph) {
        const graph = new Graph();

        const dot = graph.generate(state.analyzer.getModules());
        this.options.onGraph(dot);
      }
    });
  });
};

ShakePlugin.prototype.mapModule = function mapModule(state, compilation,
                                                     module) {
  // Skip Harmony Modules, we can't handle them anyway
  if (module.meta && module.meta.harmonyModule)
    return module;

  // Don't wrap modules that we don't own
  if (!state.resources.has(module.resource))
    return module;

  const info = state.analyzer.getModule(module.resource);
  if (info.bailouts) {
    if (this.options.onModuleBailout)
      this.options.onModuleBailout(module, info.bailouts);
    info.bailouts.forEach((bailout) => {
      if (bailout.level !== 'warning')
        return;

      // NOTE: we can't push to `module.warnings` at this step, because
      // all modules are already built
      compilation.warnings.push(new ModuleBailout(module, bailout));
    });
    return module;
  }

  const isImported = module.reasons.some((reason) => {
    return reason.dependency instanceof HarmonyImportDependency;
  });

  // We can't know what is used or not anymore if the module was imported
  if (isImported) {
    if (this.options.onModuleBailout) {
      // TODO(indutny): report source/loc
      this.options.onModuleBailout(module, [ {
        reason: 'CommonJS module was ESM imported',
        loc: null,
        source: null
      } ]);
    }
    return module;
  }

  return new ReplacementModule(info, module, {
    onExportDelete: this.options.onExportDelete
  });
};
