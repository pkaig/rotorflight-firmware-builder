# rotorflight-firmware-builder

Headless local firmware build module for the Rotorflight Configurator.

Betaflight solves the MCU flash/RAM squeeze with a hosted cloud build service that
strips unused code paths via existing `USE_XXX` compile-time defines. This project
does the same thing **locally**, on the user's own machine, so no build server has
to be hosted or maintained.

**Phase 1 (this module): CLI only, no UI.** A later phase wraps `buildFirmware()`
as a thin adapter inside the Configurator (NW.js / Node) and streams progress to a
tab. See the project scope document for the full plan.

## Requirements

- Node.js >= 22 (runs TypeScript sources directly via type stripping)
- `git` on PATH (anonymous HTTPS clone — no GitHub account needed)
- A POSIX build environment for the firmware `make`:
  - Linux / macOS: native
  - **Windows: WSL, MSYS2, or the firmware repo's Docker image** — the firmware
    Makefile does not build under plain `cmd.exe`/PowerShell
- ~1 GB free disk per cached firmware ref (source + ARM toolchain)

The ARM toolchain (`arm-none-eabi-gcc`, pinned by the firmware's
`GCC_REQUIRED_VERSION`) is installed automatically on first build. The archive
is downloaded from `developer.arm.com` by this tool, with retries and resume,
and checked against a pinned SHA-256 (`src/download.ts`). The firmware's own
`make arm_sdk_install` then only unpacks it; on its own it downloads with
`curl -k` and verifies nothing.

## Usage

```sh
npm install
npm run build            # emit dist/ (for packaging / the bin)

# or run straight from source:
npm run cli -- build --target STM32F405 --tag release/4.6.0 --features GPS,LED_STRIP,BLACKBOX

npm run cli -- features           # list friendly feature -> USE_ define mappings
npm run cli -- targets            # list target MCUs
npm run cli -- build --help
```

Artifacts (`.hex`, `.bin`, `.elf`) are copied into `./output` (override with
`--out`). `--json` prints a machine-readable result including the size report.

### Build from a local firmware clone

```sh
npm run cli -- build --target STM32F7X2 --tag release/4.6.0 \
  --source-dir ../rotorflight-firmware --features RPM_FILTER
```

## Sample app (option toggles)

A throwaway proof-of-process UI: one toggle per `USE_XXX` option, then build.
Zero dependencies — a `node:http` server plus one HTML page.

```sh
npm run app        # compiles dist/, then serves http://localhost:4780
```

On Windows this hands itself off to WSL (where `make` works); WSL forwards
localhost, so open the URL in the Windows browser. `--port <n>` picks another
port; `RFB_NO_WSL=1` skips the handoff.

**Detect board** reads the connected flight controller over Web Serial with
`MSP_BOARD_INFO`, as the Configurator's Detect does, and selects its MCU target.
Use Edge or Chrome, and close the Configurator first so the port is free.
Without a board, **pick a board** from the Configurator's list
(`rotorflight/rotorflight-targets`, cached 2h). Each board maps to a target via
its config header. The target dropdown lists the ref's real targets once its
source is on disk.

**Load & probe** finds the target's exact CFLAGS from the firmware Makefile, then
runs `arm-none-eabi-gcc -E` over `platform.h` once per candidate define
(`src/probe.ts`). Each option is classified as:

| State | Meaning | Toggle |
|---|---|---|
| removable | in the baseline, and guarded by `#ifndef DISABLE_USE_X` | live |
| baseline, locked | in the baseline, no guard — `-D` cannot remove it | subdued |
| addable | not in the baseline, `-DUSE_X` preprocesses cleanly | live |
| unavailable | `-D` collides with a header define, is `#undef`'d again, or hits an `#error` | subdued |

Changing toggles re-preprocesses the whole selection and shows the effective
change, including knock-on `#undef`s from `common_post.h`. **Build** runs
`buildFirmware()` and lists flash size against the baseline build.

**Your setup** lists features (receiver protocol, DShot, ESC telemetry, LED
strip, OSD and so on). Untick what the model does not use: options only those
features need are marked *not needed*. **Apply** switches off the removable ones,
and the locked ones are listed as the `#ifndef DISABLE_USE_X` guards the firmware
would need. Feature groups and per-option context (what it is, why to keep or
strip it, importance) live in `data/option-info.json`.

Options that are not real choices are locked even when the preprocessor would
accept them. That covers platform plumbing such as `USE_HAL_DRIVER`, which
`make/mcu/*.mk` sets for F7/H7/G4, and another MCU's hardware such as `USE_UART7`
on an F4. Click any option for a details card: where it is defined, which files
use it, its dependencies and any measured size change.

For an official release, the baseline comes straight from the `.hex` attached
to the GitHub release, so no build is needed. That applies to a release source,
or a local tree whose HEAD is exactly a release tag. The size is also shown next
to the release picker. It matches a local build of the same tag exactly; the
4-byte config-erase marker (a lone `0xFFFFFFFF` in `.flash_config`) is subtracted
unless you build with `FLASH_CONFIG_ERASE`. For other local trees the release
matching their declared `FC_VERSION`, or the newest one below it, is shown for
reference, and a local baseline build measures the tree itself. Releases publish
no ELF, so RAM use and savings estimates still need one local baseline build.
Builds are kept in `history.json` in the cache directory and survive restarts.

**Flash budget** shows the MCU's flash (`TARGET_FLASH_SIZE`). After one baseline
build it also shows the linker's per-region usage (`--print-memory-usage`) and
an estimate for the current selection. The estimate sums the baseline ELF's
symbols (`nm -S`) that sit inside each removed feature's `#ifdef` blocks, so it
is a lower bound. LED strip on F405: estimated 8.7 KB flash and 5.3 KB RAM,
measured 11.1 KB and 5.5 KB. Baselines are kept in the cache directory
(`baselines.json`), so they survive restarts.

**Firmware source** is either a Rotorflight release (from GitHub; tick *RCs &
snapshots* for more) or a **local directory** (*Open directory…* browses
folders and accepts pasted Windows paths). Nothing loads until you press
**Load firmware**. A banner shows what is loading, each step and the elapsed
time. Local trees on a Windows drive are mirrored into WSL with rsync before
each probe and build. Building on `/mnt/c` in place is impractically slow,
because the firmware Makefile's `git diff --shortstat` re-hashes the whole tree
over the drive bridge. The mirror reuses the clone's git directory and the
cached Linux toolchain, and never writes to your folder. Edits are picked up on
every Build; after adding guards, press Load firmware again to re-probe.

Removal guards are recognised in either style, under any `DISABLE_*` name:

```c
#ifndef DISABLE_USE_LED_STRIP        // around the #define
#define USE_LED_STRIP
#endif

#if defined(DISABLE_GPS)             // or an #undef after the defines
#undef USE_GPS
#endif
```

**Build** compiles. **Build & flash** also flashes the result to the connected
board over USB. The app reboots the board into its ROM DFU bootloader over the
serial port granted by *Detect*, inserts the board config exactly as the
Configurator does (byte-identical, see `src/hex.ts`), and refuses a board whose
MCU differs from the build target. It then erases only the touched sectors, so
the settings sector survives unless `FLASH_CONFIG_ERASE` was built in, writes,
reads back to verify, and restarts the board. WebUSB needs Edge or Chrome, and on
Windows the DFU device needs the WinUSB driver, as for the Configurator. Every
build in the list also has *.hex* and *flash* links.

To try a firmware-side guard, edit a copy of the firmware tree and enter its
path under *Local tree*. It is built as-is, without a checkout.

## Layout

| File | Role |
|---|---|
| `src/source.ts` | shallow clone / checkout of a firmware ref, cached per-ref |
| `src/toolchain.ts` | install + version-verify the ARM toolchain the source demands |
| `src/build.ts` | spawn `make`, collect artifacts, size report |
| `src/features.ts` | friendly feature name -> `USE_XXX` define mapping |
| `src/probe.ts` | classify each `USE_` option per target via the real preprocessor |
| `src/app/server.ts`, `app/index.html` | sample toggle UI over `buildFirmware()` |
| `src/index.ts` | `buildFirmware()` — the single entry point Phase 2 will wrap |
| `src/cli.ts` | argument parsing + human/JSON output |
| `src/errors.ts` | typed `BuildToolError` codes for every failure mode |

## Tests

```sh
npm test          # node:test, no external deps
npm run typecheck
```

Unit tests cover define assembly, streaming/exec behaviour, and CLI surface. A
real cross-platform build + diff against the official CI artifact (scope doc
§6.2) runs in CI, not here.

## Status

Phase 1. End-to-end validated on Windows-via-WSL against `release/4.6.0`
(STM32F405): clone → toolchain → compile → artifacts, and a `--config-erase`
build matches the official release hex byte-for-byte except the embedded build
timestamp. Not wired into the Configurator. Not gated for release.

Known firmware-side blocker for the UI phase: Rotorflight 4.6 builds with
`-Werror` and hard-`#define`s many `USE_XXX` features in its target headers, so
passing `-D` for an already-defined feature fails the build. See
[docs/scope-doc-updates.md](docs/scope-doc-updates.md).
