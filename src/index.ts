import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import debug from 'debug'
import {
  FileSystem,
  ResolveOptions,
  Resolver,
  ResolverFactory,
} from 'enhanced-resolve'
import { createPathsMatcher, getTsconfig } from 'get-tsconfig'
import isCore from 'is-core-module'
import isGlob from 'is-glob'
import { createSyncFn } from 'synckit'

const IMPORTER_NAME = 'eslint-import-resolver-typescript'

const log = debug(IMPORTER_NAME)

const _dirname =
  typeof __dirname === 'undefined'
    ? path.dirname(fileURLToPath(import.meta.url))
    : __dirname

const globSync = createSyncFn<typeof import('globby').globby>(
  path.resolve(_dirname, 'worker.mjs'),
)

/**
 * .mts, .cts, .d.mts, .d.cts, .mjs, .cjs are not included because .cjs and .mjs must be used explicitly.
 */
const defaultExtensions = [
  '.ts',
  '.tsx',
  '.d.ts',
  '.js',
  '.jsx',
  '.json',
  '.node',
]

const defaultMainFields = [
  'types',
  'typings',
  'module',
  'jsnext:main',

  // https://angular.io/guide/angular-package-format
  'esm2020',
  'es2020',
  'fesm2020',
  'fesm2015',

  'main',
]

const defaultConditionNames = [
  'types',
  'import',
  'require',
  'node',
  'node-addons',
  'browser',
  'default',
]

export const interfaceVersion = 2

export interface TsResolverOptions
  extends Omit<ResolveOptions, 'fileSystem' | 'useSyncFileSystemCalls'> {
  alwaysTryTypes?: boolean
  project?: string[] | string
  extensions?: string[]
  packageFilter?: (pkg: Record<string, string>) => Record<string, string>
  conditionNamesMapper?: Record<string, string[]>
}

const fileSystem = fs as FileSystem

const JS_EXT_PATTERN = /\.(?:[cm]js|jsx?)$/
const RELATIVE_PATH_PATTERN = /^\.{1,2}(?:\/.*)?$/

let mappersBuildForOptions: TsResolverOptions
let mappers: Array<((specifier: string) => string[]) | null> | undefined
let resolver: Resolver

/**
 * @param {string} source the module to resolve; i.e './some-module'
 * @param {string} file the importing file's full path; i.e. '/usr/local/bin/file.js'
 * @param {TsResolverOptions} options
 */
export function resolve(
  source: string,
  file: string,
  options?: TsResolverOptions | null,
): {
  found: boolean
  path?: string | null
} {
  const opts: Required<
    Pick<
      ResolveOptions,
      'conditionNames' | 'extensions' | 'mainFields' | 'useSyncFileSystemCalls'
    >
  > &
    ResolveOptions &
    TsResolverOptions = {
    ...options,
    extensions: options?.extensions ?? defaultExtensions,
    mainFields: options?.mainFields ?? defaultMainFields,
    conditionNames: options?.conditionNames ?? defaultConditionNames,
    fileSystem,
    useSyncFileSystemCalls: true,
  }

  resolver = ResolverFactory.createResolver(opts)

  log('looking for:', source)

  source = removeQuerystring(source)

  // don't worry about core node modules
  if (isCore(source)) {
    log('matched core:', source)

    return {
      found: true,
      path: null,
    }
  }

  initMappers(opts)

  const mappedPath = getMappedPath(source, file, opts.extensions, true)
  if (mappedPath) {
    log('matched ts path:', mappedPath)
  }

  // note that even if we map the path, we still need to do a final resolve
  let foundNodePath: string | null | undefined
  try {
    foundNodePath =
      tsResolve(mappedPath ?? source, path.dirname(path.resolve(file)), opts) ||
      null
  } catch {
    foundNodePath = null
  }

  // naive attempt at @types/* resolution,
  // if path is neither absolute nor relative
  if (
    (JS_EXT_PATTERN.test(foundNodePath!) ||
      (opts.alwaysTryTypes && !foundNodePath)) &&
    !/^@types[/\\]/.test(source) &&
    !path.isAbsolute(source) &&
    !source.startsWith('.')
  ) {
    const definitelyTyped = resolve(
      '@types' + path.sep + mangleScopedPackage(source),
      file,
      options,
    )
    if (definitelyTyped.found) {
      return definitelyTyped
    }
  }

  if (foundNodePath) {
    log('matched node path:', foundNodePath)

    return {
      found: true,
      path: foundNodePath,
    }
  }

  log("didn't find ", source)

  return {
    found: false,
  }
}

function resolveExtension(id: string) {
  const idWithoutJsExt = removeJsExtension(id)

  if (idWithoutJsExt === id) {
    return
  }

  if (id.endsWith('.cjs')) {
    return {
      path: idWithoutJsExt,
      extensions: ['.cts', '.d.cts'],
    }
  }

  if (id.endsWith('.mjs')) {
    return {
      path: idWithoutJsExt,
      extensions: ['.mts', '.d.mts'],
    }
  }

  return {
    path: idWithoutJsExt,
  }
}

/**
 * Like `sync` from `resolve` package, but considers that the module id
 * could have a .cjs, .mjs, .js or .jsx extension.
 */
function tsResolve(
  source: string,
  base: string,
  options: ResolveOptions,
): string | false {
  try {
    return resolver.resolveSync({}, base, source)
  } catch (error) {
    const resolved = resolveExtension(source)
    if (resolved) {
      const resolver = ResolverFactory.createResolver({
        ...options,
        extensions: resolved.extensions ?? options.extensions,
      })
      return resolver.resolveSync({}, base, resolved.path)
    }
    throw error
  }
}

/** Remove any trailing querystring from module id. */
function removeQuerystring(id: string) {
  const querystringIndex = id.lastIndexOf('?')
  if (querystringIndex >= 0) {
    return id.slice(0, querystringIndex)
  }
  return id
}

/** Remove .cjs, .mjs, .js or .jsx extension from module id. */
function removeJsExtension(id: string) {
  return id.replace(JS_EXT_PATTERN, '')
}

const isFile = (path?: string | undefined): path is string => {
  try {
    return !!path && fs.statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} source the module to resolve; i.e './some-module'
 * @param {string} file the importing file's full path; i.e. '/usr/local/bin/file.js'
 * @param {string[]} extensions the extensions to try
 * @param {boolean} retry should retry on failed to resolve
 * @returns The mapped path of the module or undefined
 */
// eslint-disable-next-line sonarjs/cognitive-complexity
function getMappedPath(
  source: string,
  file: string,
  extensions: string[] = defaultExtensions,
  retry?: boolean,
): string | undefined {
  const originalExtensions = extensions
  extensions = ['', ...extensions]

  let paths: string[] | undefined = []

  if (RELATIVE_PATH_PATTERN.test(source)) {
    const resolved = path.resolve(path.dirname(file), source)
    if (isFile(resolved)) {
      paths = [resolved]
    }
  } else {
    paths = mappers!
      .map(mapper =>
        mapper?.(source).map(item => [
          ...extensions.map(ext => `${item}${ext}`),
          ...originalExtensions.map(ext => `${item}/index${ext}`),
        ]),
      )
      .flat(2)
      .filter(isFile)
  }

  if (retry && paths.length === 0) {
    const isJs = JS_EXT_PATTERN.test(source)
    if (isJs) {
      const jsExt = path.extname(source)
      const tsExt = jsExt.replace('js', 'ts')
      const basename = source.replace(JS_EXT_PATTERN, '')

      const resolved =
        getMappedPath(basename + tsExt, file) ||
        getMappedPath(
          basename + '.d' + (tsExt === '.tsx' ? '.ts' : tsExt),
          file,
        )

      if (resolved) {
        return resolved
      }
    }

    for (const ext of extensions) {
      const resolved =
        (isJs ? null : getMappedPath(source + ext, file)) ||
        getMappedPath(source + `/index${ext}`, file)

      if (resolved) {
        return resolved
      }
    }
  }

  if (paths.length > 1) {
    log('found multiple matching ts paths:', paths)
  }

  return paths[0]
}

function initMappers(options: TsResolverOptions) {
  if (mappers && mappersBuildForOptions === options) {
    return
  }

  const configPaths =
    typeof options.project === 'string'
      ? [options.project]
      : Array.isArray(options.project)
      ? options.project
      : [process.cwd()]

  const ignore = ['!**/node_modules/**']

  // turn glob patterns into paths
  const projectPaths = [
    ...new Set([
      ...configPaths.filter(path => !isGlob(path)),
      ...globSync([...configPaths.filter(path => isGlob(path)), ...ignore]),
    ]),
  ]

  mappers = projectPaths.map(projectPath => {
    const tsconfigResult = getTsconfig(projectPath)
    return tsconfigResult && createPathsMatcher(tsconfigResult)
  })

  mappersBuildForOptions = options
}

/**
 * For a scoped package, we must look in `@types/foo__bar` instead of `@types/@foo/bar`.
 */
function mangleScopedPackage(moduleName: string) {
  if (moduleName.startsWith('@')) {
    const replaceSlash = moduleName.replace(path.sep, '__')
    if (replaceSlash !== moduleName) {
      return replaceSlash.slice(1) // Take off the "@"
    }
  }
  return moduleName
}
