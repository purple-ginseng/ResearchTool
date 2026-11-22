# Contributing

Thanks for taking an interest. ResearchTool is a personal project, so replies may take a while, but issues and pull
requests are welcome.

## Running it

```bash
node server.js                                   # http://localhost:4790, data in ./workspace
RT_WORKSPACE=/tmp/rt-dev PORT=4841 node server.js  # a throw-away workspace on another port (macOS, Linux)
```

```powershell
$env:RT_WORKSPACE="$env:TEMP\rt-dev"; $env:PORT=4841; node server.js   # the same in Windows PowerShell
```

Node 18 or newer is enough; there are no npm dependencies and no build step. Use a separate `PORT` and
`RT_WORKSPACE` while developing so your own workspace is left alone. [ARCHITECTURE.md](ARCHITECTURE.md) describes the
code layout and has a testing recipe with `curl`.

## Tests

The tests are plain Node scripts without a framework, server or network access; each one uses a temporary workspace.

```bash
node scripts/run-tests.js            # every scripts/test-*.js, with a summary; exit code 1 if one fails
node scripts/i18n-extract.js --check # every UI string has a Chinese translation (exit code 1 otherwise)
node scripts/smoke-server.js         # starts the real server on a free port with a temporary workspace and a fake
                                     # claude, and checks the page, read-only API endpoints, the security gate and
                                     # a project download (--pdf adds a PDF import, which needs poppler)
```

`node scripts/smoke-server.js --port N --tmp DIR` picks the port and the folder for the temporary workspace. A single
test runs on its own too, for example `node scripts/test-platform.js` (it simulates Windows paths and commands, so it
runs on any system).

Please run them before opening a pull request, and add a test next to the existing ones when you fix a bug in
`lib/`.

## Continuous integration

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the three commands above on Ubuntu,
macOS and Windows with Node 20 and 24 (and Node 18 on Ubuntu) for every push to `main` and every pull request, checks
that the checkout has LF line ends, and runs the smoke test with a PDF import on all three systems. A pull request
should be green on all of them; if you cannot test on one system yourself, CI does it for you.

## Guidelines

- **Code style**: follow the existing vanilla JavaScript - CommonJS modules in `lib/`, plain scripts on the `RT`
  namespace in `public/js/`, no frameworks, no transpiling, no bundler. Keep the server free of npm dependencies.
- **Cross-platform**: start programs with `core.run()` / `spawnTool()` from `lib/platform.js`, never through a shell, build paths with `path`, and
  keep text files LF (`.gitattributes` does this for git). What differs between macOS, Linux and Windows belongs in
  `lib/platform.js`, with a case in `scripts/test-platform.js`.
- **No build step**: files in `public/` are served as they are. Third-party browser code goes into `public/vendor/`
  with its licence file, and gets a row in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Files in
  `public/vendor/` are stored byte for byte (`-text` in `.gitattributes`).
- **Translations**: the interface is English and Chinese. Every new UI string needs an entry in
  `public/js/i18n/zh.js`; `node scripts/i18n-extract.js --check` must pass. How the translation layer works is
  described in [docs/preferences.md](docs/preferences.md).
- **Local only**: the server must keep listening on 127.0.0.1 and keep the same-origin checks in `server.js`.
  New online lookups should send no more than an id, DOI or title, and be described in the README's Privacy section.
- **User data**: never commit anything from a `workspace/` folder. Keep changes to the workspace format backward
  compatible, or migrate old data in `core.migrate()`.
- Keep pull requests focused, and describe what you changed and how you tested it.
