import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The published entry points are compiled JavaScript.
 *
 * `main` and `types` used to point at src/index.ts. Metro reads the
 * `react-native` field and compiles TypeScript, so apps built - but a consumer's
 * Jest resolves `main`, and by default does not transform node_modules, so every
 * test file that imported the SDK failed with a syntax error on the first type
 * annotation. `npm run build` (run by `prepare` and `pretest`) produces lib/.
 */
const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('package entry points', () => {
  it('main and types point at the build output, react-native at the source', () => {
    expect(pkg.main).toBe('lib/index.js');
    expect(pkg.types).toBe('lib/index.d.ts');
    expect(pkg['react-native']).toBe('src/index.ts');
    expect(pkg.files).toEqual(expect.arrayContaining(['lib/', 'src/']));
    expect(pkg.scripts.prepare).toBeDefined();
  });

  // Scan 4 #3: the lockfile had been generated inside the monorepo, so five
  // entries were `"link": true` into ../../node_modules/.pnpm - paths that do
  // not exist in the public repository. `npm ci` (and `prepare`, which builds
  // lib/) broke in every clean clone. Regenerated in an isolated folder.
  it('has a lockfile that resolves from the registry only, never into the monorepo', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    const local = Object.entries(lock.packages as Record<string, { link?: boolean; resolved?: string }>)
      .filter(([key, entry]) =>
        key.startsWith('..') ||
        entry.link === true ||
        (typeof entry.resolved === 'string' && !entry.resolved.startsWith('https://')),
      )
      .map(([key]) => key);
    expect(local).toEqual([]);
    expect(lock.packages[''].devDependencies).toEqual(pkg.devDependencies);
  });

  // With npm 7+ auto-installing peers, react-native resolved to its latest
  // release and its @types/react ^19 peer clashed with the @types/react ^18
  // dev dependency: ERESOLVE, so a clean clone could not install at all.
  it('installs without peer auto-install, so a clean clone resolves', () => {
    const npmrc = fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^legacy-peer-deps=true$/m);
  });

  /**
   * Built FRESH from src/ here (scan 6 N7): the test used to load whatever
   * lib/ the checkout had, so a lib/ built before the latest src/ change
   * passed it - the round-5 worktree's lib/ had none of that round's fixes.
   * `prepare` rebuilds lib/ on publish; this pins that the build output of
   * the CURRENT source loads as plain JavaScript, wherever the build writes.
   */
  it('main is the build output of src, and that output loads as plain JavaScript', () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
    const outDir = path.normalize(tsconfig.compilerOptions.outDir);
    expect(path.normalize(path.dirname(pkg.main))).toBe(outDir);
    expect(path.normalize(path.dirname(pkg.types))).toBe(outDir);
    expect(tsconfig.compilerOptions.declaration).toBe(true);

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jry-rn-build-'));
    try {
      const tsc = require.resolve('typescript/bin/tsc');
      // Type errors are `npm run typescript`'s to report; tsc emits anyway,
      // and what is pinned here is that the emitted file loads.
      try {
        execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', out], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        // checked below: the output must exist
      }
      const main = path.join(out, path.basename(pkg.main));
      expect(fs.existsSync(main)).toBe(true);
      expect(fs.existsSync(path.join(out, path.basename(pkg.types)))).toBe(true);

      jest.spyOn(console, 'warn').mockImplementation(() => {});
      let loaded: { default?: { track?: unknown } } | undefined;
      jest.isolateModules(() => {
        jest.doMock(
          'react-native',
          () => ({ NativeModules: {}, NativeEventEmitter: class {} }),
          { virtual: true },
        );
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        loaded = require(main);
      });
      expect(typeof loaded?.default?.track).toBe('function');
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  });
});

// Scan 5 S4: `files` listed "android/", so a publish from a checkout that had
// built the bridge shipped android/build/** - Gradle and Kotlin caches, and
// merger.xml with the absolute local path of the checkout - about 800 KB of it.
// The package's own .gitignore lists only lib/, and npm never reads the
// monorepo root one. Packed here from a copy with build output planted in it.
describe('npm pack', () => {
  it('ships the sources and never build output, Gradle/CMake caches or tsbuildinfo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jry-rn-pack-'));
    try {
      for (const entry of ['package.json', 'joryio-react-native.podspec', 'react-native.config.js', 'LICENSE', 'README.md', 'CHANGELOG.md', 'src', 'ios', 'android']) {
        fs.cpSync(path.join(ROOT, entry), path.join(dir, entry), { recursive: true });
      }
      // No lifecycle scripts in the copy: npm 10.9.x runs `prepare` on
      // `npm pack` even with --ignore-scripts, and this copy has no tsconfig
      // to build with. Scripts never change what `files` packs, which is all
      // this test reads.
      const copied = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      delete copied.scripts;
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(copied, null, 2));
      fs.mkdirSync(path.join(dir, 'lib'));
      fs.writeFileSync(path.join(dir, 'lib/index.js'), '');
      fs.writeFileSync(path.join(dir, 'lib/index.d.ts'), '');
      const junk = [
        'android/build/intermediates/merger.xml',
        'android/.gradle/8.7/checksums.bin',
        'android/.cxx/Debug/x.o',
        'android/local.properties',
        'android/src/test/Probe.kt',
        'ios/build/JoryioModule.o',
        'lib/tsconfig.tsbuildinfo',
      ];
      for (const file of junk) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), 'junk');
      }
      const npm = path.join(path.dirname(process.execPath), 'npm');
      const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
      expect(files.filter((f) => junk.includes(f))).toEqual([]);
      expect(files.filter((f) => /(^|\/)(build|\.gradle|\.cxx)\//.test(f))).toEqual([]);
      expect(files).toEqual(expect.arrayContaining([
        'android/build.gradle',
        'android/src/main/java/io/joryio/reactnative/JoryioModule.kt',
        'android/src/main/java/io/joryio/reactnative/JoryioPackage.kt',
        'ios/JoryioModule.swift',
        'ios/JoryioModule.m',
        'joryio-react-native.podspec',
        'react-native.config.js',
        'lib/index.js',
        'lib/index.d.ts',
        'src/index.ts',
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
