# Changelog

All notable changes to Rojo Feature Sync are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-15

### Added

- Feature-first `src/Core`, `src/Features`, and `src/Startup` project initialization.
- Generated client and server bootstrapper scripts.
- Initial Core, Features, and bootstrapper Rojo mappings.
- Dynamic Client, Server, and Shared feature mapping based on runtime directories that exist.
- Deterministic full-rescan synchronization for new, deleted, renamed, and moved runtimes.
- Persistent synchronization controlled by `rojo-feature-sync.toml`.
- Automatic configuration migration with versioned project configuration.
- Commands to initialize, start synchronization, sync immediately, and create runtimes.
- Status bar synchronization indicator with one-click manual sync.
- Dedicated Rojo Feature Sync output channel.
- Problems-panel diagnostics for configuration, structure, casing, duplicates, and missing entry points.
- Quick Fix support for incorrectly cased runtime folders.
- Automatic `.gitignore` entries for Wally packages, lockfile, and project configuration.
- Dynamic `Packages` and `ServerPackages` Rojo mappings that follow root package-folder creation and deletion.
- Automatic Selene Roblox standard configuration.
- Commands to pause and resume live synchronization, with a full rescan on resume.

### Behavior

- First initialization removes the existing `src` directory and unrelated Rojo tree mappings only after explicit confirmation.
- Routine synchronization replaces only managed mappings and preserves unrelated mappings.
- Client-only, Server-only, Shared-only, and mixed-runtime features are supported without placeholder directories.
