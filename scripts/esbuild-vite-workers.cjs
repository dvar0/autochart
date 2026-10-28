// Electron test harnesses bundle the app with esbuild, which doesn't know
// Vite's `?worker&inline` imports. Give them a worker that fails to start, so
// the app takes its main-thread path, as it does where workers are missing.
module.exports = {
  name: "vite-inline-worker",
  setup(build) {
    build.onResolve({ filter: /\?worker&inline$/ }, (args) => ({ path: args.path, namespace: "vite-inline-worker" }));
    build.onLoad({ filter: /.*/, namespace: "vite-inline-worker" }, () => ({
      contents: 'export default class { constructor() { throw new Error("Workers are not bundled in tests."); } }',
      loader: "js",
    }));
  },
};
