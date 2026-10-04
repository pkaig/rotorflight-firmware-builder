# Rotorflight — Custom Firmware Build Capability
### Project Scope, Process Steps & Test Process
_Living reference — check against this at each phase boundary, update as decisions firm up._

---

## 1. Background

Rotorflight is constrained by MCU flash/RAM limits, which is blocking new feature work. Betaflight solves an equivalent problem with a hosted cloud build service (`build.betaflight.com`): users pick a target and feature set in the Configurator, the server compiles a stripped firmware using existing `USE_XXX` compile-time defines, and returns a hex for flashing.

Rather than replicate that as hosted infrastructure (server cost, scaling, abuse/queue management, ongoing maintenance), the preferred direction is to do the same thing **locally** — clone source and invoke a toolchain on the user's own machine instead of a shared server. Local build was assessed as having a smaller blast radius than a hosted service for firmware that controls physical hardware (a compromised central build server can poison every user's output at once; a compromised local toolchain download, checksum-verified, affects one machine and has to defeat that check first).

## 2. ⚠️ Stack — needs verification against the actual repo

Earlier planning carried an **unconfirmed assumption** that the Configurator stack was Tauri (Rust backend) + Svelte, based on Betaflight Configurator's own move from NW.js to Tauri — that detail was never actually confirmed against the Rotorflight/WingFlight codebase itself.

**Confirmed so far:** Node.js + Svelte for the UI layer.
**Not yet confirmed:** what native shell (if any) the Configurator runs in — NW.js (what Betaflight ran before its Tauri migration, and what Rotorflight would have inherited as a fork), Electron, Tauri, or no native shell at all if it's already closer to a plain web app.

This matters directly for the custom-build app (§5) — the native-process/filesystem access needed to run a local toolchain doesn't require Tauri specifically; NW.js and Electron can both do it too. **First task when picking this back up with repo access: confirm the actual native layer (check `package.json` dependencies, `src-tauri/` presence or absence, electron-builder config, etc.) and correct this section.**

## 3. Objective

Let a user select a target board and a set of optional features, produce a custom-compiled firmware binary **on their own machine**, and flash it — without any hosted build service, and in one continuous flow rather than a build step followed by a separate manual flash step.

## 4. Architecture decision: two-app split

The main Configurator has started migrating to a PWA. A PWA runs in the browser sandbox and cannot spawn native processes or invoke a compiler — there's no browser API equivalent to what a native toolchain invocation needs (WebSerial/WebUSB cover *flashing* a prebuilt binary, which is why the PWA migration doesn't break that part, but there's nothing comparable for *compiling*).

Resolution: **split by user type rather than compromising either app**.

| | Standard user | Custom user |
|---|---|---|
| App | Main Configurator (PWA / desktop) | Standalone custom-build app (native) |
| Capability | Flash precompiled official-release firmware, as today | Select features → compile locally → flash, in one flow |
| Why | Never needs to compile anything, so it's free to go full PWA | Needs real native process/filesystem access for the toolchain |

This also resolves the earlier open question about whether the main Configurator needed to stay Tauri-based — it doesn't; only the custom-build app needs a native shell, and that shell doesn't have to be Tauri (see §2).

Reference point for this split: ExpressLRS Configurator is itself a desktop app split into a UI layer and a local "api-server" native helper — i.e. prior art for "UI talks to a local native component doing the real work" existing happily alongside a product that also has a pure web flashing path.

Note on ExpressLRS as a UX model, not a technical one: ELRS's single "Build & Flash" click feels seamless because their CI **pre-builds** firmware for every hardware target and the desktop app mostly **patches** small runtime config values (binding phrase, regulatory domain) into an existing binary — no per-user compile at all. That doesn't transfer to Rotorflight's actual problem: the goal here is excluding unused feature code *at compile time* to save flash, which can't be done by patching an already-built binary, and pre-building every feature-flag combination doesn't scale the way pre-building one binary per board does for ELRS. ELRS is the UX shape to aim for (one continuous flow), not the build mechanism.

## 5. Process Steps

### Phase 0 — Groundwork
- **Confirm the actual native shell** (§2) — gates everything else in this phase
- Confirm which build system the target Rotorflight source branch uses (make vs cmake)
- Inventory existing `USE_XXX` flags relevant to helicopter-specific features
- Pin exact toolchain version (mirror whatever version-pinning the firmware repo's own build already enforces)
- Identify Arm's official checksum source for that toolchain release (Arm GNU Toolchain, developer.arm.com — publishes checksums per release)

### Phase 1 — Headless build module (no UI)
- Standalone binary/library with a CLI wrapper, independent of whatever app framework Phase 0 confirms: `buildtool --target STM32F405 --features GPS,LED_STRIP --tag v2.x.x`
- Implements: toolchain fetch + checksum verify, shallow git clone/checkout (public repo, anonymous HTTPS, no account needed), process spawn for the build, structured stdout/stderr capture
- Fully testable in isolation — no app framework, no window, no UI

### Phase 2 — Native app integration
- Wrap the Phase 1 module as commands in whatever native shell is confirmed (Tauri commands, Electron IPC handlers, or NW.js equivalent)
- Stream build progress back to the frontend
- Local toolchain cache directory + ccache for repeat builds

### Phase 3 — Standalone custom-build app UI
(Revised from "Configurator tab integration" after the two-app split decision in §4.)
- Feature checkboxes mapped to defines, target/version selectors
- Build happens, then **flashes directly in the same flow** — no separate "load local file" step in a different tab
- Progress/log display spanning build → connect device → flash → verify
- Keep the artifact around after a successful build so a failed flash can be retried without rebuilding
- Keep a fast path (official release, no compile) as the default/first option — not every flash should force a build
- Cache recent builds keyed by (version, target, feature-set) so re-flashing a second board with the same config doesn't trigger a pointless rebuild
- Share flashing/device-connect/bootloader-entry logic and target metadata as a common library with the main Configurator, rather than duplicating and risking drift

### Phase 4 — Rollout
- A separate app is inherently opt-in — nobody runs it unless they went looking for it, which doubles as the rollout gate
- Add discoverability from the main Configurator (a link/button: "Need a custom build? Get the Build Tool")
- Scheduled CI job (see §6.4) validating the pipeline against each new tagged release on an ongoing basis

---

## 6. Test Process

### 6.1 Pipeline tests (headless module)
- Unit tests with a mocked toolchain: correct define assembly per feature selection; clean failure on missing toolchain, checksum mismatch, failed clone, disk space
- Real (non-mocked) run across Windows/macOS/Linux in CI as a proxy for a user's first-run machine

### 6.2 Build correctness
- **Diff against official CI artifact**: same commit + target + feature set, compare local build output against Rotorflight's existing CI build for that tag (mask/exclude embedded build-timestamp/git-hash bytes, or compare `.elf` rather than final `.hex`)
- **Reproducibility**: build the same input twice locally, outputs should match
- **Size sanity check**: `arm-none-eabi-size`/`objdump` — confirm plausible text/data/bss for target flash size, and confirm toggling a feature moves size in the expected direction

### 6.3 Hardware confirmation
- Flash to real target hardware via the custom-build app's own flash step
- `version`/`status` over CLI — confirms boot, correct target name, correct build options
- CLI `diff` against an officially-built firmware with identical config — should match
- Per-feature check via CLI (`feature` list, relevant `get`/`set`) — confirms each toggle is actually wired, not just compiling clean
- Bench smoke test (gyro/PID loop, motor response, props off) before sign-off

### 6.4 Ongoing drift detection
- Scheduled job: run the local-build path against each new tagged release, diff against that release's official artifact
- Catches the pipeline silently drifting out of sync with firmware source changes over time

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Toolchain supply-chain compromise | Fetch only from Arm's official domain, verify published checksum before any use, pin exact version |
| Self-hosted mirror weakening trust chain | Do not mirror the toolchain on own infrastructure — fetch direct from Arm |
| First-run download size/friction | Download-on-first-use with clear progress UI; cache persistently |
| Cross-platform build inconsistency | CI matrix across Win/macOS/Linux in Phase 1 before any app-framework work begins |
| Feature flag compiles but isn't wired | Per-feature CLI verification step in §6.3, not just build success |
| Native shell assumption wrong (this happened once already — see §2) | Confirm against the actual repo before Phase 2 starts, don't carry assumptions forward as fact |

## 8. Open Questions
- **Confirm the actual native shell** (NW.js / Electron / Tauri / none) — see §2
- Confirm current build system (make vs cmake) on the active Rotorflight source branch
- Decide beta/opt-in gating criteria for Phase 4 (though the separate-app structure already provides a natural gate)
- Investigate Rotorflight's existing Profiles tab CLI interaction pattern — deferred, may inform how the custom-build app talks to connected hardware
