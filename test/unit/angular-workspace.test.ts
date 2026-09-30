import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAngularWorkspace } from '../../src/adapters/angular/workspace.ts';
import { detectFramework } from '../../src/project.ts';

test('angular.json: application builder options merged with the serve configuration', () => {
  const build = readAngularWorkspace({
    'angular.json': JSON.stringify({
      projects: {
        lib: { projectType: 'library', architect: { build: { builder: '@angular/build:ng-packagr' } } },
        shop: {
          projectType: 'application',
          sourceRoot: 'src',
          architect: {
            build: {
              builder: '@angular/build:application',
              options: {
                browser: 'src/main.ts',
                tsConfig: 'tsconfig.app.json',
                polyfills: ['zone.js'],
                styles: ['src/styles.scss', { input: 'src/lazy.css', inject: false }, { input: 'node_modules/x/theme.css' }],
                assets: [{ glob: '**/*', input: 'public' }, 'src/favicon.ico', 'src/assets', { glob: '**/*', input: 'node_modules/icons/svg/', output: '/icons/' }],
                inlineStyleLanguage: 'scss',
                stylePreprocessorOptions: { includePaths: ['src/theme'] },
              },
              configurations: { development: { tsConfig: 'tsconfig.dev.json' } },
            },
            serve: { builder: '@angular/build:dev-server', options: { buildTarget: 'shop:build:development' } },
          },
        },
      },
    }),
  });
  assert.equal(build.project, 'shop');
  assert.equal(build.main, 'src/main.ts');
  assert.equal(build.tsConfig, 'tsconfig.dev.json');
  assert.equal(build.index, 'src/index.html');
  assert.deepEqual(build.polyfills, ['zone.js']);
  assert.deepEqual(build.styles, ['src/styles.scss', 'node_modules/x/theme.css']);
  assert.deepEqual(build.assets, [
    { input: 'public', output: '/' },
    { input: 'src/favicon.ico', output: '/favicon.ico' },
    { input: 'src/assets', output: '/assets' },
    { input: 'node_modules/icons/svg', output: '/icons' },
  ]);
  assert.equal(build.inlineStyleLanguage, 'scss');
  assert.deepEqual(build.includePaths, ['src/theme']);
});

test('older workspaces: main instead of browser, polyfills as a string', () => {
  const build = readAngularWorkspace({
    'angular.json': JSON.stringify({
      defaultProject: 'app',
      projects: { app: { architect: { build: { builder: '@angular-devkit/build-angular:browser', options: { main: 'src/main.ts', polyfills: 'src/polyfills.ts', index: 'src/index.html' } } } } },
    }),
  });
  assert.equal(build.main, 'src/main.ts');
  assert.deepEqual(build.polyfills, ['src/polyfills.ts']);
  assert.equal(build.builder, '@angular-devkit/build-angular:browser');
});

test('Angular projects are detected', () => {
  assert.equal(detectFramework({ 'package.json': '{}' }, { dependencies: { '@angular/core': '^22.0.0' } }), 'angular');
  assert.equal(detectFramework({ 'angular.json': '{}' }, null), 'angular');
});
