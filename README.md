# Rojo Feature Sync

Rojo Feature Sync is a VS Code extension for organizing Roblox projects around self-contained features. It creates a predictable Client, Server, and Shared architecture, generates the corresponding Rojo mappings, and keeps `default.project.json` synchronized as runtime folders change.

## Features

- Initializes a feature-first Roblox source layout.
- Generates client and server bootstrap scripts.
- Maps Core and feature runtimes into the correct Roblox services.
- Watches `src/Features`, `src/Core`, and `src/Startup` for changes.
- Performs deterministic full rescans instead of incremental JSON edits.
- Supports Client-only, Server-only, Shared-only, and mixed-runtime features.
- Preserves unrelated Rojo mappings during routine synchronization.
- Reports project issues in VS Code's Problems panel.
- Offers Quick Fixes for incorrectly cased runtime folders.
- Displays synchronization state in the status bar.
- Writes detailed activity to the **Rojo Feature Sync** output channel.
- Migrates projects created with older configuration versions.

## Requirements

- VS Code `1.125.0` or newer.
- A Rojo project with `default.project.json` and `src` in the workspace root.
- A valid JSON object in `default.project.json`.

The generated client bootstrapper waits for the local player's `Loaded` attribute to become `true`. Your game must set that attribute as part of its loading flow.

## Getting Started

> [!CAUTION]
> Initialization replaces the existing `src` directory only after showing a modal confirmation. It also replaces the first-run Rojo tree with the managed runtime hierarchy. Commit or back up the project before confirming initialization.

1. Open the Roblox project folder in VS Code.
2. Confirm that `default.project.json` and `src` exist at the workspace root.
3. Open the Command Palette.
4. Run **Rojo Feature Sync: Initialize**.
5. Review the warning and select **Yes, Proceed** only when the project is backed up.

Initialization creates the architecture, bootstrap scripts, configuration, Rojo mappings, Selene standard, and ignore entries. Synchronization starts immediately afterward.

## Generated Architecture

```text
src/
├── Core/
│   ├── Client/
│   ├── Server/
│   └── Shared/
├── Features/
└── Startup/
    ├── ClientBootstrapper.client.luau
    └── ServerBootstrapper.server.luau
```

The base paths are mapped as follows:

| Filesystem path | Roblox location |
| --- | --- |
| `src/Core/Client` | `StarterPlayer.StarterPlayerScripts.Core` |
| `src/Core/Server` | `ServerScriptService.Core` |
| `src/Core/Shared` | `ReplicatedStorage.Shared.Core` |
| `Packages` | `ReplicatedStorage.Packages` |
| `ServerPackages` | `ServerScriptService.ServerPackages` |
| `src/Startup/ClientBootstrapper.client.luau` | `StarterPlayer.StarterPlayerScripts.ClientBootstrapper` |
| `src/Startup/ServerBootstrapper.server.luau` | `ServerScriptService.ServerBootstrapper` |

## Creating Features

A feature may contain any combination of the exact runtime folder names `Client`, `Server`, and `Shared`:

```text
src/Features/Inventory/
├── Client/
│   └── init.luau
├── Server/
│   └── init.luau
└── Shared/
    └── init.luau
```

This produces these mappings:

```text
Inventory/Client → StarterPlayerScripts/Features/Inventory
Inventory/Server → ServerScriptService/Features/Inventory
Inventory/Shared → ReplicatedStorage/Shared/Features/Inventory
```

Only runtime directories that exist are mapped. For example, a Client-only feature does not require empty Server or Shared directories.

You can create the folders manually or run **Rojo Feature Sync: Create Runtime**. The command prompts for a Feature or Core target and a runtime, then creates the directory. Client and Server runtimes also receive an `init.luau` template without overwriting an existing entry point; Shared runtimes do not require one.

## Commands

| Command | Purpose |
| --- | --- |
| **Rojo Feature Sync: Initialize** | Replaces the existing source architecture and creates the initial mappings. |
| **Rojo Feature Sync: Start Synchronization** | Starts the filesystem watchers and performs a full rescan. |
| **Rojo Feature Sync: Sync Now** | Requests an immediate full rescan without restarting the watcher. |
| **Rojo Feature Sync: Pause Live Sync** | Temporarily ignores filesystem changes without stopping the synchronization session. |
| **Rojo Feature Sync: Resume Live Sync** | Resumes filesystem monitoring and performs a full rescan. |
| **Rojo Feature Sync: Create Runtime** | Creates a Feature or Core runtime, including `init.luau` for Client and Server. |

Clicking the Rojo Sync status bar item also runs **Sync Now**.

## Configuration

Initialization creates `rojo-feature-sync.toml`:

```toml
version = 1
runoninit = true
```

- `version` identifies the project configuration format used for migration.
- `runoninit = true` starts synchronization whenever the workspace reopens.
- Changing `runoninit` to `false` stops automatic synchronization. It can still be started manually from the Command Palette.

Older configurations are migrated to version 1 when synchronization starts. Migration preserves user-created feature directories while refreshing generated architecture files and mappings.

## Synchronization Behavior

Folder creation, deletion, and renaming under `src/Features`, `src/Core`, `src/Startup`, `Packages`, or `ServerPackages` schedules a synchronization. Events are debounced, and each synchronization rescans the complete feature directory before replacing the managed mappings. Package mappings are added only while their corresponding root folders exist, so installing or deleting packages updates the project file automatically.

Live synchronization can be paused from the Command Palette. Changes made while paused are not processed automatically; resuming always performs a full rescan, so all accumulated filesystem changes are applied at once. **Sync Now** remains available for an intentional manual rescan while live sync is paused.

The first initialization intentionally removes unrelated service mappings from the Rojo `tree`. Top-level project properties such as the project name and place IDs remain intact. After initialization, routine and manual synchronization update only these managed entries:

- `ReplicatedStorage.Shared.Core`
- `ReplicatedStorage.Shared.Features`
- `ReplicatedStorage.Packages`
- `ServerScriptService.ServerPackages`
- `ServerScriptService.Core`
- `ServerScriptService.Features`
- `ServerScriptService.ServerBootstrapper`
- `StarterPlayer.StarterPlayerScripts.Core`
- `StarterPlayer.StarterPlayerScripts.Features`
- `StarterPlayer.StarterPlayerScripts.ClientBootstrapper`

Unrelated mappings added after initialization are preserved.

## Diagnostics and Quick Fixes

Rojo Feature Sync reports the following in VS Code's Problems panel:

- Malformed `default.project.json`.
- Invalid or outdated project configuration.
- Missing required project paths.
- Missing Client or Server runtime `init.luau` files.
- Files placed directly in a feature instead of a runtime folder.
- Unknown runtime directories.
- Incorrect runtime casing such as `client`, `CLIENT`, or `shared`.
- Duplicate case variants such as `Client` and `client`.

For a single incorrectly cased runtime folder, use the offered Quick Fix to rename it to `Client`, `Server`, or `Shared`. The rename preserves the folder contents. Diagnostics are regenerated and removed automatically when their causes are fixed.

## Status and Logs

The status bar shows the current state:

```text
Rojo Sync ✓   synchronized
Rojo Sync...  synchronization in progress
Rojo Sync ⚠   disabled or failed
```

Open **View → Output** and select **Rojo Feature Sync** for watcher activity, feature counts, project updates, migrations, warnings, and errors.

## Other Generated Changes

Initialization preserves existing content while adding these `.gitignore` entries when missing:

```gitignore
Packages
ServerPackages
wally.lock
rojo-feature-sync.toml
```

It also creates or updates `selene.toml` with:

```toml
std = "roblox"
```

## Known Limitations

- Multi-root workspaces currently use the first workspace folder.
- Feature runtime names are case-sensitive and must be exactly `Client`, `Server`, or `Shared`.
- Initialization is destructive by design; it is not a migration tool for an arbitrary existing `src` layout.

## Development

```sh
npm install
npm run compile
npm run lint
```

Use `npm run watch` while developing the extension.

## Release Notes

Release history is included in the extension's CHANGELOG file.

## License

Rojo Feature Sync is available under the MIT License included with the extension.
