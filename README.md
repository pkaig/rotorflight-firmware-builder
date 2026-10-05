# Rotorflight Firmware Builder

Build custom Rotorflight firmware on your own PC, with only the features your
model uses, then flash it to the flight controller.

Betaflight solves the MCU flash/RAM squeeze with a hosted cloud build service
that strips unused code paths via the firmware's `USE_XXX` compile-time
defines. This project does the same thing **locally**, so no build server has
to be hosted or maintained.

It comes as:

- a **desktop app** (Windows installer or portable `.exe`, built with Electron),
- the same app as a **local web page** (`npm run app`, for Edge or Chrome),
- a **command-line tool** (`rf-buildtool`) and a Node module (`buildFirmware()`).

## Desktop app

### Install

Run `Rotorflight Firmware Builder Setup <version>.exe`, or use the portable
`.exe`, which needs no install. Both are unsigned for now, so Windows
SmartScreen may warn: choose **More info → Run anyway**.

### First run

The firmware build needs a few free tools. If any are missing, the app offers to
**Load build environment**: click OK and it installs them with winget, Windows'
package manager:

- **Git for Windows**, whose signed Unix tools (sh, sed, find, …) run the
  firmware Makefile;
- **GNU make** (`ezwinports.make`).

The ARM compiler (about 180 MB) downloads automatically the first time you load
a firmware. Its SHA-256 is checked against a pinned value before it is
installed. Nothing unsigned is bundled with the app.

Finished builds go to `Documents\Rotorflight Firmware Builder` (**File → Open
builds folder**).

### Using it

1. **Detect board** reads the connected flight controller over USB, as the
   Configurator's Detect does, and selects its MCU target. Or pick the board
   from the list (the Configurator's `rotorflight-targets`). A board that is
   already plugged in and permitted is detected automatically at start-up.
2. Choose the **firmware source**: a Rotorflight release from GitHub (tick
   *RCs & snapshots* for more), or a **local directory**, such as your own clone
   with firmware-side changes. A local tree is built exactly as it is on disk.
3. **Load firmware**. The first load of a release fetches its source and the
   toolchain, which takes a few minutes. The app then probes every `USE_`
   option for the target with the real preprocessor. A banner shows each step.
4. In **Your setup**, untick what the model does not use (GPS, LED strip, OSD,
   telemetry protocols and so on). Options that only those features need are
   marked *not needed* and switched off. Ticking a feature with an opt-in
   (`ENABLE_`) guard switches its option on.
5. Review the **Options** list. *Changes* (the default) shows only what differs
   from the stock firmware, including knock-on effects. *Baseline* shows what
   the stock build contains, and *All* shows everything. The **i** button on an
   option opens its details: what it is, when to keep or strip it, where it is
   defined and used, and any measured size change.
6. **Selection** shows the effective change after all headers. Name the build
   if you like (e.g. *OMP M4*), then **Build**, or **Build & flash**.

The **Flash budget** compares the baseline, an estimate for the current
selection, and the measured size once built. The **Log** shows 10 lines; click
it for 20. **Builds** lists every build with its size change, a *.hex*
download, a *flash* link, rename and delete.

### Option states

| State | Meaning |
|---|---|
| removable | in the stock build, and the firmware has a removal guard for it |
| baseline, locked | in the stock build with no guard: `-D` cannot remove it |
| addable | not in the stock build; `-DUSE_X` or an `ENABLE_` flag adds it cleanly |
| follows X | goes (or comes) automatically with X; needs no flag of its own |
| unavailable | `-D` collides with a header define, is `#undef`'d again, or is another MCU's hardware |

Platform plumbing (e.g. `USE_HAL_DRIVER`) and another MCU's hardware are locked
even when the preprocessor would accept them. Feature groups and per-option
context live in `data/option-info.json`.

### Firmware guards

`-D` can only add a define, so stripping a stock feature needs a guard in the
firmware headers. Any `DISABLE_*` name works, in either style:

```c
#ifndef DISABLE_USE_LED_STRIP        // around the #define
#define USE_LED_STRIP
#endif

#if defined(DISABLE_GPS)             // or an #undef after the defines
#undef USE_GPS
#endif
```

An opt-in works the other way round: `#if !defined(ENABLE_CMS) … #undef USE_CMS`
makes `USE_CMS` addable with `ENABLE_CMS`. Stock Rotorflight 4.6 has no such
guards, so there every stock feature is locked. Your setup lists the guards that
would make the unneeded ones removable. After adding guards to a local tree,
press **Load firmware** again to re-probe. (Builds always use the tree's
current code.)

### Sizes

- For an official release, the baseline comes from the `.hex` published on
  GitHub, so no build is needed. It matches a local build of the same tag
  exactly; the 4-byte config-erase marker is subtracted unless you build with
  `FLASH_CONFIG_ERASE`.
- A local tree uses its last baseline build or, before that, the nearest
  release as an approximation.
- One local baseline build measures the tree itself and gives the linker's
  per-region usage, RAM use and savings estimates. An estimate sums the
  baseline ELF's symbols (`nm -S`) inside each removed feature's `#ifdef`
  blocks, so it is a lower bound. For example, LED strip on F405 was estimated
  at 8.7 KB flash and measured at 11.1 KB.

Builds and baselines are kept in the cache directory (`history.json`,
`baselines.json`) and survive restarts.

### Flashing

**Build & flash**, or *flash* on any build:

1. reboots the board into its DFU bootloader over the serial port from Detect;
2. inserts the board config exactly as the Configurator does (byte-identical,
   see `src/hex.ts`), and refuses a board whose MCU differs from the build;
3. erases only the sectors it writes, so settings survive unless the build has
   `FLASH_CONFIG_ERASE`;
4. writes, reads everything back to verify, and restarts the board.

A board already in DFU mode (hold BOOT while plugging in) is flashed directly.
On Windows the DFU device needs the WinUSB driver, as for the Configurator
(ImpulseRC Driver Fixer or Zadig). You can also load the downloaded `.hex` into
the Configurator's Firmware Flasher with **Load Firmware [Local]**.

## Running from source

Requires Node.js 22 or newer (TypeScript runs directly via type stripping).

```sh
npm install
npm run desktop     # the desktop app
npm run app         # the same app in your browser: http://localhost:4780
npm run dist:win    # Windows installer + portable .exe into release/
```

`npm run app` options: `--port <n>`, `--host <h>`. The server only listens on
127.0.0.1 and only answers its own page: requests with a foreign `Host` header,
non-JSON POSTs and cross-origin POSTs are refused.

Build environment by platform:

- **Windows**: native, with Git for Windows and GNU make as above. Without them,
  `npm run app` hands itself off to WSL instead (set `RFB_NO_WSL=1` to stop
  that). Under WSL, local trees on a Windows drive are mirrored into WSL with
  rsync before each probe and build, because the firmware Makefile's
  `git diff --shortstat` is impractically slow over `/mnt/c`. The mirror never
  writes to your folder.
- **Linux / macOS**: `make` and `git` on PATH.

Environment variables:

| Variable | Effect |
|---|---|
| `RFB_CACHE_DIR` | cache root (sources, toolchains, history), default `%LOCALAPPDATA%` / `~/.cache` |
| `RFB_OUTPUT_DIR` | where builds are copied (the desktop app sets Documents) |
| `RFB_FIRMWARE_REPO` | firmware git URL to clone releases from |
| `RFB_NO_WSL` | `npm run app` on Windows: never hand off to WSL |
| `RFB_SIMULATE_MISSING` | developer switch: `make,git` pretends they are missing |
| `RFB_SELFTEST` | desktop app smoke test: load the page, print `SELFTEST {…}`, quit |

## Command line

```sh
npm run cli -- build --target STM32F405 --tag release/4.6.0 --features GPS,LED_STRIP,BLACKBOX
npm run cli -- build --target STM32F7X2 --tag release/4.6.0 --source-dir ../rotorflight-firmware
npm run cli -- features           # friendly feature -> USE_ define mappings
npm run cli -- targets            # target MCUs (--tag or --source-dir to read a tree)
npm run cli -- build --help
```

Artifacts (`.hex`, `.bin`, `.elf`) go to `./output` (`--out` to change).
`--json` prints a machine-readable result with the size report. Note that
`--source-dir` checks out `--tag` in that clone (it must have no uncommitted
changes); the app, by contrast, builds a local tree as-is.

## Layout

| File | Role |
|---|---|
| `electron/main.mjs`, `electron/preload.cjs` | desktop shell: window, menu, permissions, in-page device chooser |
| `src/app/server.ts` | app server: API, jobs, live events, sizes, build history |
| `app/index.html` | the app page |
| `app/flasher.js` | MSP over Web Serial (detect, reboot) and STM32 DfuSe flashing over WebUSB |
| `src/app/dirs.ts`, `src/app/mirror.ts` | folder browser; WSL mirror of Windows-drive trees |
| `src/index.ts` | `buildFirmware()` and the module's public API |
| `src/probe.ts` | classify each `USE_` option per target with the real preprocessor |
| `src/size.ts` | linker region parsing and the removal estimate |
| `src/hex.ts` | Intel HEX parsing and board-config insertion |
| `src/releases.ts`, `src/boards.ts` | GitHub releases and official sizes; the board list |
| `src/buildenv.ts` | find (or install with winget) the build tools |
| `src/source.ts`, `src/toolchain.ts`, `src/download.ts` | cached checkouts; toolchain install with verified download |
| `src/build.ts` | run `make`, collect artifacts, size report |
| `src/option-info.ts`, `data/option-info.json` | option descriptions and Your setup features |
| `src/cli.ts`, `src/features.ts` | command line; friendly feature names |
| `src/errors.ts` | typed `BuildToolError` codes |

## Tests

```sh
npm test            # node:test, no external deps
npm run typecheck
```

## Status

Validated on Windows, natively and under WSL: a `--config-erase` build of
`release/4.6.0` matches the official release hex byte for byte apart from the
embedded build timestamp, and Build & flash has been flashed and verified on a
real board. Not yet wired into the Configurator.

Stripping stock features needs guards in the firmware (see
[Firmware guards](#firmware-guards) and
[docs/scope-doc-updates.md](docs/scope-doc-updates.md)): Rotorflight builds with
`-Werror` and hard-`#define`s many features in its target headers.
