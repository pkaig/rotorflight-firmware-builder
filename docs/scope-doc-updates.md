# Scope-doc updates — Phase 0 outcomes

Paste these into the project scope document ("Rotorflight Configurator — Local
Firmware Build Feature"). They replace assumptions with what was verified against
the firmware repo at tag `release/4.6.0` and the Configurator `master`.

---

## §3 Scope — clarification

Under **In scope**, replace "Local invocation of the existing make/cmake build"
with:

> - Local invocation of the existing **GNU Make** build with user-selected
>   `USE_XXX` defines (passed as `OPTIONS="USE_A USE_B"`, which the firmware
>   Makefile turns into `-DUSE_A -DUSE_B`)

Under **In scope**, add:

> - On Windows, the firmware build runs through a POSIX environment (WSL, MSYS2,
>   or the firmware repo's Docker image); the module detects and drives one rather
>   than requiring a native `make`.

---

## §4 Architecture Overview — replace the diagram's runtime layer

The Configurator is **NW.js** (`nw-builder`) + Cordova with a Vite/Svelte
frontend — not Tauri. NW.js already exposes full Node integration
(`child_process`, `fs`), so no Rust/Tauri layer is needed.

```
Configurator Tab (Svelte UI)
        │  feature selection, target, version
        ▼
NW.js Node backend  (thin adapter over buildFirmware())
        │
        ├─▶ Toolchain manager  → make arm_sdk_install (Arm's pinned GCC, checksum-verified)
        ├─▶ Source manager     → shallow clone / checkout, cached per ref
        └─▶ Build runner       → spawn make with selected OPTIONS
        ▼
   Output .hex/.bin ──▶ existing Flash Firmware tab
```

The core pipeline is a standalone headless Node/TypeScript module
(`rotorflight-firmware-builder`), CLI-testable, with `buildFirmware()` as the
single entry point Phase 2 wraps.

---

## §5 Process Steps

### Phase 1 — replace "Rust binary/library with a CLI wrapper" with:

> - **Node/TypeScript** library + CLI wrapper:
>   `rf-buildtool build --target STM32F405 --features GPS,LED_STRIP --tag release/4.6.0`
> - Node/TS chosen over Rust because the Configurator is NW.js: Phase 2 becomes a
>   direct in-process call rather than a sidecar/IPC boundary, and no new
>   toolchain is added to the contributor/CI requirements. The module still ships
>   a standalone CLI (and a single-file executable build) for CI use.

### Phase 2 — replace "Wrap the same module as Tauri commands" with:

> - Wrap `buildFirmware()` as an NW.js Node-context call behind the tab (no logic
>   rewrite — thin adapter). If a future Configurator moves to Tauri, the same
>   module is driven as a sidecar binary instead; no pipeline changes either way.

---

## §7 Risks & Mitigations — add a row

| Risk | Mitigation |
|---|---|
| Windows has no native `make`; firmware Makefile needs a POSIX env | Module detects and drives WSL / MSYS2 / the repo Docker image; CI covers the Windows-via-WSL path explicitly; clear error if none is available |

---

## §3 / new firmware-side blocker — feature defines collide with -Werror

Verified by an end-to-end build: Rotorflight 4.6 compiles with `-Werror`, and its
target headers (e.g. `src/main/target/STM32_UNIFIED/target.h`) hard-`#define` many
`USE_XXX` features. Passing `-DUSE_X` for a feature the target already defines is a
`"USE_X" redefined` error and **fails the build**.

Consequence: Betaflight's "pass every selected feature as `-D`" model does not work
as-is on Rotorflight. It only works for defines the chosen target does not already
set. Turning this into a real feature-selection UI requires one of:

- **Firmware-side (preferred, tracked separately):** wrap feature defines in
  `#ifndef` guards, or adopt a `build_options.mk`-style mechanism (Betaflight added
  this; Rotorflight 4.6 does not have it). This is the concrete form of the §3
  out-of-scope "firmware-side work".
- **Tool-side (interim):** compute a per-target "addable" feature set by parsing
  the target headers, and only expose those. Fragile; a stopgap at best.

The scope doc should record this as the gating dependency for Phase 3 (the UI),
and Phase 1's feature map is only meaningful for not-already-defined features until
it is resolved.

## §6.2 — build correctness result (STM32F405, release/4.6.0)

A local build with `FLASH_CONFIG_ERASE=yes` matches the official
`rotorflight_4.6.0_STM32F405.hex` release artifact **byte-for-byte except the
embedded build timestamp** (same git hash). The official build invocation is
`make unified FC_VER_SUFFIX="<pre>" FLASH_CONFIG_ERASE=yes`
(`.github/workflows/release.yml`).

Two consecutive local builds are **not** byte-identical because of the embedded
date/time. The §6.4 drift job must either mask those bytes or the build must
support `SOURCE_DATE_EPOCH` / a fixed timestamp. Recommend comparing `.elf`
`.text`/`.rodata` sections, or masked `.hex`, not raw `.hex`.

## §5 Phase 1 — additional required behaviour (learned from the e2e run)

- The module must run `make clean` whenever the target / option set / make-vars
  change: Rotorflight's Makefile has no dependency on `OPTIONS`, so an incremental
  rebuild after a feature-set change silently produces a **stale binary**. (A
  wrong-feature firmware would flash without error.)
- The target list must include *alt* targets (`STM32F405`, `STM32H743`, …), which
  live as `src/main/target/STM32_UNIFIED/<NAME>.mk`, not just base `target.mk`
  directories.
- The module needs a make-variable passthrough for at least `FLASH_CONFIG_ERASE`
  and `FC_VER_SUFFIX` (and `EXST` for H7).

## §8 Open Questions — resolved

- **Build system (make vs cmake):** GNU **Make**. No `CMakeLists.txt` or `cmake/`
  directory exists, even at `release/4.6.0` — Rotorflight did not follow
  Betaflight's CMake migration. Entry point is the root `Makefile`; feature
  defines go in `OPTIONS`.
  - Toolchain pinned to `arm-none-eabi-gcc` **9.3.1**
    (`gcc-arm-none-eabi-9-2020-q2-update`), from
    `developer.arm.com/.../9-2020q2`, enforced by an exact-equality check in
    `make/tools.mk`. `make arm_sdk_install` performs the download + checksum.
  - Current firmware line is **4.6.0** (`release/4.6.0`; `snapshot/4.6.0-*` for
    bleeding edge).

- **Configurator runtime (Tauri vs migration needed):** It is **NW.js**, not
  Tauri, and **no migration is needed** — NW.js's Node integration already
  provides the process/filesystem access this feature requires. The tab must be
  hidden under the Cordova/mobile and any pure-browser build.

- **Beta/opt-in gating criteria:** _(still open — decision pending)_ Recommended
  approach: a dedicated opt-in toggle in the Options tab (default off, one-time
  consent dialog) **plus** a remote-config flag (reusing the `ReleaseChecker`
  pattern already in `firmware_flasher.js`) as a maintainer kill switch, with
  `minConfiguratorVersion` / `minFirmwareTag` fences. Start nightly-only for one
  release cycle, then allow in stable behind the toggle. Graduate to default-on
  after: CI matrix green on Win/macOS/Linux (x64 + arm64) first-run builds; §6.4
  drift job matching the official artifact for 3 consecutive tagged releases; a
  full §6.3 hardware pass on F4/F7/H7/G4; no open "bad/bricked firmware" bug;
  actionable error messages for the disk/network/checksum/compile failure modes;
  and beta support-issue volume within a bound the maintainers set. The genuinely
  open sub-decisions for the maintainers: who the beta cohort is, and the
  acceptable support-issue volume.
