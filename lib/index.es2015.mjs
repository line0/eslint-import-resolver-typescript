import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import debug from 'debug';
import { ResolverFactory } from 'enhanced-resolve';
import { parseTsconfig, getTsconfig, createPathsMatcher } from 'get-tsconfig';
import isCore from 'is-core-module';
import isGlob from 'is-glob';
import { createSyncFn } from 'synckit';

var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
const import_meta = {};
const IMPORTER_NAME = "eslint-import-resolver-typescript";
const log = debug(IMPORTER_NAME);
const _dirname = typeof __dirname === "undefined" ? path.dirname(fileURLToPath(import_meta.url)) : __dirname;
const globSync = createSyncFn(path.resolve(_dirname, "worker.mjs"));
const defaultExtensions = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".js",
  ".jsx",
  ".json",
  ".node"
];
const defaultMainFields = [
  "types",
  "typings",
  "module",
  "jsnext:main",
  "esm2020",
  "es2020",
  "fesm2020",
  "fesm2015",
  "main"
];
const defaultConditionNames = [
  "types",
  "import",
  "require",
  "node",
  "node-addons",
  "browser",
  "default"
];
const interfaceVersion = 2;
const fileSystem = fs;
const JS_EXT_PATTERN = /\.(?:[cm]js|jsx?)$/;
const RELATIVE_PATH_PATTERN = /^\.{1,2}(?:\/.*)?$/;
let mappersBuildForOptions;
let mappers;
let resolver;
function resolve(source, file, options) {
  var _a, _b, _c;
  const opts = __spreadProps(__spreadValues({}, options), {
    extensions: (_a = options == null ? void 0 : options.extensions) != null ? _a : defaultExtensions,
    mainFields: (_b = options == null ? void 0 : options.mainFields) != null ? _b : defaultMainFields,
    conditionNames: (_c = options == null ? void 0 : options.conditionNames) != null ? _c : defaultConditionNames,
    fileSystem,
    useSyncFileSystemCalls: true
  });
  resolver = ResolverFactory.createResolver(opts);
  log("looking for:", source);
  source = removeQuerystring(source);
  if (isCore(source)) {
    log("matched core:", source);
    return {
      found: true,
      path: null
    };
  }
  initMappers(opts);
  const mappedPath = getMappedPath(source, file, opts.extensions, true);
  if (mappedPath) {
    log("matched ts path:", mappedPath);
  }
  let foundNodePath;
  try {
    foundNodePath = tsResolve(mappedPath != null ? mappedPath : source, path.dirname(path.resolve(file)), opts) || null;
  } catch (e) {
    foundNodePath = null;
  }
  if ((JS_EXT_PATTERN.test(foundNodePath) || opts.alwaysTryTypes && !foundNodePath) && !/^@types[/\\]/.test(source) && !path.isAbsolute(source) && !source.startsWith(".")) {
    const definitelyTyped = resolve("@types" + path.sep + mangleScopedPackage(source), file, options);
    if (definitelyTyped.found) {
      return definitelyTyped;
    }
  }
  if (foundNodePath) {
    log("matched node path:", foundNodePath);
    return {
      found: true,
      path: foundNodePath
    };
  }
  log("didn't find ", source);
  return {
    found: false
  };
}
function resolveExtension(id) {
  const idWithoutJsExt = removeJsExtension(id);
  if (idWithoutJsExt === id) {
    return;
  }
  if (id.endsWith(".cjs")) {
    return {
      path: idWithoutJsExt,
      extensions: [".cts", ".d.cts"]
    };
  }
  if (id.endsWith(".mjs")) {
    return {
      path: idWithoutJsExt,
      extensions: [".mts", ".d.mts"]
    };
  }
  return {
    path: idWithoutJsExt
  };
}
function tsResolve(source, base, options) {
  var _a;
  try {
    return resolver.resolveSync({}, base, source);
  } catch (error) {
    const resolved = resolveExtension(source);
    if (resolved) {
      const resolver2 = ResolverFactory.createResolver(__spreadProps(__spreadValues({}, options), {
        extensions: (_a = resolved.extensions) != null ? _a : options.extensions
      }));
      return resolver2.resolveSync({}, base, resolved.path);
    }
    throw error;
  }
}
function removeQuerystring(id) {
  const querystringIndex = id.lastIndexOf("?");
  if (querystringIndex >= 0) {
    return id.slice(0, querystringIndex);
  }
  return id;
}
function removeJsExtension(id) {
  return id.replace(JS_EXT_PATTERN, "");
}
const isFile = (path2) => {
  try {
    return !!path2 && fs.statSync(path2).isFile();
  } catch (e) {
    return false;
  }
};
function getMappedPath(source, file, extensions = defaultExtensions, retry) {
  const originalExtensions = extensions;
  extensions = ["", ...extensions];
  let paths = [];
  if (RELATIVE_PATH_PATTERN.test(source)) {
    const resolved = path.resolve(path.dirname(file), source);
    if (isFile(resolved)) {
      paths = [resolved];
    }
  } else {
    paths = mappers.map((mapper) => mapper == null ? void 0 : mapper(source).map((item) => [
      ...extensions.map((ext) => `${item}${ext}`),
      ...originalExtensions.map((ext) => `${item}/index${ext}`)
    ])).flat(2).filter(isFile);
  }
  if (retry && paths.length === 0) {
    const isJs = JS_EXT_PATTERN.test(source);
    if (isJs) {
      const jsExt = path.extname(source);
      const tsExt = jsExt.replace("js", "ts");
      const basename = source.replace(JS_EXT_PATTERN, "");
      const resolved = getMappedPath(basename + tsExt, file) || getMappedPath(basename + ".d" + (tsExt === ".tsx" ? ".ts" : tsExt), file);
      if (resolved) {
        return resolved;
      }
    }
    for (const ext of extensions) {
      const resolved = (isJs ? null : getMappedPath(source + ext, file)) || getMappedPath(source + `/index${ext}`, file);
      if (resolved) {
        return resolved;
      }
    }
  }
  if (paths.length > 1) {
    log("found multiple matching ts paths:", paths);
  }
  return paths[0];
}
function initMappers(options) {
  if (mappers && mappersBuildForOptions === options) {
    return;
  }
  const configPaths = typeof options.project === "string" ? [options.project] : Array.isArray(options.project) ? options.project : [process.cwd()];
  const ignore = ["!**/node_modules/**"];
  const projectPaths = [
    .../* @__PURE__ */ new Set([
      ...configPaths.filter((path2) => !isGlob(path2)),
      ...globSync([...configPaths.filter((path2) => isGlob(path2)), ...ignore])
    ])
  ];
  mappers = projectPaths.map((projectPath) => {
    const tsconfigResult = fs.existsSync(projectPath) && fs.statSync(projectPath).isFile() ? { path: projectPath, config: parseTsconfig(projectPath) } : getTsconfig(projectPath);
    return tsconfigResult && createPathsMatcher(tsconfigResult);
  });
  mappersBuildForOptions = options;
}
function mangleScopedPackage(moduleName) {
  if (moduleName.startsWith("@")) {
    const replaceSlash = moduleName.replace(path.sep, "__");
    if (replaceSlash !== moduleName) {
      return replaceSlash.slice(1);
    }
  }
  return moduleName;
}

export { interfaceVersion, resolve };
