import * as vscode from "vscode";
import startupCode from "./StartupCode.json";

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

interface JsonObject {
	[key: string]: JsonValue;
}

interface ProjectFileContents {
	project: JsonObject;
	originalText: string;
}

interface FeatureMappings {
	client: JsonObject;
	server: JsonObject;
	shared: JsonObject;
}

interface SynchronizationSession extends vscode.Disposable {
	requestSync(): void;
}

let activeSynchronization: SynchronizationSession | undefined;
let outputChannel: vscode.OutputChannel;
let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let initializationInProgress = false;

function log(level: "Info" | "Warning" | "Error", message: string): void {
	outputChannel.appendLine(`[${level}] ${message}`);
}

function setSyncStatus(state: "disabled" | "syncing" | "ready" | "warning", detail?: string): void {
	const statuses = {
		disabled: "$(circle-slash) Rojo Sync",
		syncing: "$(sync~spin) Rojo Sync...",
		ready: "$(check) Rojo Sync",
		warning: "$(warning) Rojo Sync",
	};
	statusBarItem.text = statuses[state];
	statusBarItem.tooltip = detail ?? "Rojo Feature Sync";
	statusBarItem.command = "rojo-feature-sync.syncNow";
	statusBarItem.show();
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (!workspaceFolder) {
		void vscode.window.showErrorMessage("No workspace folder is open.");
	}
	return workspaceFolder;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function asObject(value: JsonValue | undefined): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function createArchitecture(workspaceFolderUri: vscode.Uri): Promise<void> {
	const srcFolderUri = vscode.Uri.joinPath(workspaceFolderUri, "src");
	const coreFolderUri = vscode.Uri.joinPath(srcFolderUri, "Core");
	const featuresFolderUri = vscode.Uri.joinPath(srcFolderUri, "Features");
	const startupFolderUri = vscode.Uri.joinPath(srcFolderUri, "Startup");

	await Promise.all([
		vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(coreFolderUri, "Client")),
		vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(coreFolderUri, "Server")),
		vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(coreFolderUri, "Shared")),
		vscode.workspace.fs.createDirectory(featuresFolderUri),
		vscode.workspace.fs.createDirectory(startupFolderUri),
	]);

	await Promise.all([
		vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(startupFolderUri, "ClientBootstrapper.client.luau"),
			new TextEncoder().encode(startupCode.Client),
		),
		vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(startupFolderUri, "ServerBootstrapper.server.luau"),
			new TextEncoder().encode(startupCode.Server),
		),
	]);
}

async function readProjectFile(projectFileUri: vscode.Uri): Promise<ProjectFileContents | undefined> {
	const originalText = new TextDecoder().decode(await vscode.workspace.fs.readFile(projectFileUri));

	try {
		const parsed: unknown = JSON.parse(originalText);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("the root value must be an object");
		}
		diagnosticCollection.delete(projectFileUri);
		return { project: parsed as JsonObject, originalText };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log("Error", `Failed to parse default.project.json: ${message}`);
		diagnosticCollection.set(projectFileUri, [
			new vscode.Diagnostic(
				new vscode.Range(0, 0, 0, 1),
				`Invalid project configuration: ${message}`,
				vscode.DiagnosticSeverity.Error,
			),
		]);
		setSyncStatus("warning", "Invalid default.project.json");
		return undefined;
	}
}

async function writeProjectFile(
	projectFileUri: vscode.Uri,
	project: JsonObject,
	originalText: string,
): Promise<boolean> {
	const generatedText = `${JSON.stringify(project, null, "\t")}\n`;
	if (generatedText !== originalText) {
		await vscode.workspace.fs.writeFile(projectFileUri, new TextEncoder().encode(generatedText));
		log("Info", "Updated default.project.json");
		return true;
	}
	return false;
}

async function updateGitIgnore(workspaceFolderUri: vscode.Uri): Promise<void> {
	const gitIgnoreUri = vscode.Uri.joinPath(workspaceFolderUri, ".gitignore");
	const entries = ["Packages", "ServerPackages", "wally.lock", "rojo-feature-sync.toml"];
	let contents = "";

	if (await pathExists(gitIgnoreUri)) {
		contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitIgnoreUri));
	}

	const existingEntries = new Set(
		contents
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean),
	);
	const missingEntries = entries.filter((entry) => !existingEntries.has(entry));
	if (missingEntries.length === 0) {
		return;
	}

	const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : "";
	const updatedContents = `${contents}${separator}${missingEntries.join("\n")}\n`;
	await vscode.workspace.fs.writeFile(gitIgnoreUri, new TextEncoder().encode(updatedContents));
}

async function updateSeleneConfig(workspaceFolderUri: vscode.Uri): Promise<void> {
	const seleneUri = vscode.Uri.joinPath(workspaceFolderUri, "selene.toml");
	let contents = "";
	if (await pathExists(seleneUri)) {
		contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(seleneUri));
	}

	const desiredSetting = 'std = "roblox"';
	const lines = contents.split(/\r?\n/);
	const settingIndexes = lines
		.map((line, index) => (/^\s*std\s*=/.test(line) ? index : -1))
		.filter((index) => index >= 0);

	if (settingIndexes.length === 1 && lines[settingIndexes[0]].trim() === desiredSetting) {
		return;
	}

	if (settingIndexes.length > 0) {
		lines[settingIndexes[0]] = desiredSetting;
		for (const index of settingIndexes.slice(1).reverse()) {
			lines.splice(index, 1);
		}
	} else {
		if (lines.length === 1 && lines[0] === "") {
			lines.length = 0;
		}
		lines.push(desiredSetting);
	}

	await vscode.workspace.fs.writeFile(
		seleneUri,
		new TextEncoder().encode(`${lines.join("\n").replace(/\n+$/, "")}\n`),
	);
}

function folderNode(children: JsonObject = {}): JsonObject {
	return { $className: "Folder", ...children };
}

function applyBaseMappings(project: JsonObject): void {
	const existingTree = asObject(project.tree);
	const tree: JsonObject = {};
	for (const [key, value] of Object.entries(existingTree)) {
		if (key.startsWith("$")) {
			tree[key] = value;
		}
	}
	project.tree = tree;
	if (!("$className" in tree)) {
		tree.$className = "DataModel";
	}

	const replicatedStorage = asObject(tree.ReplicatedStorage);
	tree.ReplicatedStorage = replicatedStorage;
	replicatedStorage.Packages = { $path: "Packages" };
	const shared = asObject(replicatedStorage.Shared);
	replicatedStorage.Shared = shared;
	shared.$className = "Folder";
	shared.Core = { $path: "src/Core/Shared" };
	shared.Features = folderNode();

	const serverScriptService = asObject(tree.ServerScriptService);
	tree.ServerScriptService = serverScriptService;
	serverScriptService.Core = { $path: "src/Core/Server" };
	serverScriptService.Features = folderNode();
	serverScriptService.ServerBootstrapper = {
		$path: "src/Startup/ServerBootstrapper.server.luau",
	};

	const starterPlayer = asObject(tree.StarterPlayer);
	tree.StarterPlayer = starterPlayer;
	const starterPlayerScripts = asObject(starterPlayer.StarterPlayerScripts);
	starterPlayer.StarterPlayerScripts = starterPlayerScripts;
	starterPlayerScripts.Core = { $path: "src/Core/Client" };
	starterPlayerScripts.Features = folderNode();
	starterPlayerScripts.ClientBootstrapper = {
		$path: "src/Startup/ClientBootstrapper.client.luau",
	};
}

async function scanFeatures(workspaceFolderUri: vscode.Uri): Promise<FeatureMappings> {
	const featuresFolderUri = vscode.Uri.joinPath(workspaceFolderUri, "src", "Features");
	const configUri = vscode.Uri.joinPath(workspaceFolderUri, "rojo-feature-sync.toml");
	const diagnostics: vscode.Diagnostic[] = [];
	const diagnosticRange = new vscode.Range(0, 0, 0, 1);
	for (const requiredPath of [
		"rojo-feature-sync.toml",
		"default.project.json",
		"src/Core",
		"src/Features",
		"src/Startup",
	]) {
		if (!(await pathExists(vscode.Uri.joinPath(workspaceFolderUri, ...requiredPath.split("/"))))) {
			diagnostics.push(
				new vscode.Diagnostic(
					diagnosticRange,
					`Missing required project path: ${requiredPath}`,
					vscode.DiagnosticSeverity.Error,
				),
			);
		}
	}

	if (await pathExists(configUri)) {
		const configContents = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
		if (!/^\s*version\s*=\s*1\s*(?:#.*)?$/im.test(configContents)) {
			diagnostics.push(
				new vscode.Diagnostic(
					diagnosticRange,
					"Invalid project configuration: version must be 1.",
					vscode.DiagnosticSeverity.Error,
				),
			);
		}
		if (!/^\s*runoninit\s*=\s*(true|false)\s*(?:#.*)?$/im.test(configContents)) {
			diagnostics.push(
				new vscode.Diagnostic(
					diagnosticRange,
					"Invalid project configuration: runoninit must be true or false.",
					vscode.DiagnosticSeverity.Error,
				),
			);
		}
	}

	if (!(await pathExists(featuresFolderUri))) {
		diagnosticCollection.set(configUri, diagnostics);
		return { client: {}, server: {}, shared: {} };
	}
	const entries = await vscode.workspace.fs.readDirectory(featuresFolderUri);
	const featureNames = entries
		.filter(([, type]) => (type & vscode.FileType.Directory) !== 0)
		.map(([name]) => name)
		.sort((a, b) => a.localeCompare(b));

	const mappings: FeatureMappings = { client: {}, server: {}, shared: {} };
	for (const featureName of featureNames) {
		const featureUri = vscode.Uri.joinPath(featuresFolderUri, featureName);
		const runtimeEntries = await vscode.workspace.fs.readDirectory(featureUri);
		for (const [entryName, entryType] of runtimeEntries) {
			if ((entryType & vscode.FileType.Directory) === 0) {
				diagnostics.push(
					new vscode.Diagnostic(
						diagnosticRange,
						`Invalid feature structure: ${featureName}/${entryName} must be inside a runtime folder.`,
						vscode.DiagnosticSeverity.Warning,
					),
				);
			}
		}
		const runtimeDirectories = new Set(
			runtimeEntries
				.filter(([, type]) => (type & vscode.FileType.Directory) !== 0)
				.map(([name]) => name),
		);
		for (const expectedName of ["Client", "Server", "Shared"]) {
			const caseInsensitiveMatches = [...runtimeDirectories].filter(
				(name) => name.toLowerCase() === expectedName.toLowerCase(),
			);
			if (caseInsensitiveMatches.length > 1) {
				diagnostics.push(
					new vscode.Diagnostic(
						diagnosticRange,
						`Duplicate runtime folders: ${featureName} has ${caseInsensitiveMatches.join(" and ")}.`,
						vscode.DiagnosticSeverity.Error,
					),
				);
			} else if (caseInsensitiveMatches.length === 1 && caseInsensitiveMatches[0] !== expectedName) {
				const actualName = caseInsensitiveMatches[0];
				const diagnostic = new vscode.Diagnostic(
					diagnosticRange,
					`Invalid runtime folder casing in ${featureName}: expected "${expectedName}", found "${actualName}".`,
					vscode.DiagnosticSeverity.Warning,
				);
				diagnostic.code = "runtime-casing";
				diagnostic.relatedInformation = [
					new vscode.DiagnosticRelatedInformation(
						new vscode.Location(vscode.Uri.joinPath(featureUri, actualName), diagnosticRange),
						`Rename to ${expectedName}`,
					),
				];
				diagnostics.push(diagnostic);
			}
		}

		for (const runtimeName of runtimeDirectories) {
			if (!["client", "server", "shared"].includes(runtimeName.toLowerCase())) {
				diagnostics.push(
					new vscode.Diagnostic(
						diagnosticRange,
						`Invalid feature structure: unknown runtime folder ${featureName}/${runtimeName}.`,
						vscode.DiagnosticSeverity.Warning,
					),
				);
			}
		}

		for (const [runtimeName, target] of [
			["Client", mappings.client],
			["Server", mappings.server],
			["Shared", mappings.shared],
		] as const) {
			if (runtimeDirectories.has(runtimeName)) {
				target[featureName] = { $path: `src/Features/${featureName}/${runtimeName}` };
				const initUri = vscode.Uri.joinPath(featureUri, runtimeName, "init.luau");
				if (runtimeName !== "Shared" && !(await pathExists(initUri))) {
					diagnostics.push(
						new vscode.Diagnostic(
							diagnosticRange,
							`Missing init.luau: ${featureName}/${runtimeName}/init.luau`,
							vscode.DiagnosticSeverity.Warning,
						),
					);
				}
			}
		}
	}

	for (const diagnostic of diagnostics) {
		log(
			diagnostic.severity === vscode.DiagnosticSeverity.Error ? "Error" : "Warning",
			diagnostic.message,
		);
	}
	diagnosticCollection.set(configUri, diagnostics);
	log("Info", `Found ${featureNames.length} features`);

	return mappings;
}

function setPathMapping(parent: JsonObject, key: string, path: string, exists: boolean): void {
	if (exists) {
		parent[key] = { $path: path };
	} else {
		delete parent[key];
	}
}

async function syncFeatureMappings(
	projectFileUri: vscode.Uri,
	workspaceFolderUri: vscode.Uri,
): Promise<boolean> {
	const contents = await readProjectFile(projectFileUri);
	if (!contents) {
		return false;
	}

	const mappings = await scanFeatures(workspaceFolderUri);
	const tree = asObject(contents.project.tree);
	contents.project.tree = tree;
	const replicatedStorage = asObject(tree.ReplicatedStorage);
	tree.ReplicatedStorage = replicatedStorage;
	const shared = asObject(replicatedStorage.Shared);
	replicatedStorage.Shared = shared;
	const serverScriptService = asObject(tree.ServerScriptService);
	tree.ServerScriptService = serverScriptService;
	const starterPlayer = asObject(tree.StarterPlayer);
	tree.StarterPlayer = starterPlayer;
	const starterPlayerScripts = asObject(starterPlayer.StarterPlayerScripts);
	starterPlayer.StarterPlayerScripts = starterPlayerScripts;
	const [
		packagesExist,
		serverPackagesExist,
		sharedCoreExists,
		serverCoreExists,
		clientCoreExists,
		serverBootstrapperExists,
		clientBootstrapperExists,
	] =
		await Promise.all([
			pathExists(vscode.Uri.joinPath(workspaceFolderUri, "Packages")),
			pathExists(vscode.Uri.joinPath(workspaceFolderUri, "ServerPackages")),
			pathExists(vscode.Uri.joinPath(workspaceFolderUri, "src", "Core", "Shared")),
			pathExists(vscode.Uri.joinPath(workspaceFolderUri, "src", "Core", "Server")),
			pathExists(vscode.Uri.joinPath(workspaceFolderUri, "src", "Core", "Client")),
			pathExists(
				vscode.Uri.joinPath(
					workspaceFolderUri,
					"src",
					"Startup",
					"ServerBootstrapper.server.luau",
				),
			),
			pathExists(
				vscode.Uri.joinPath(
					workspaceFolderUri,
					"src",
					"Startup",
					"ClientBootstrapper.client.luau",
				),
			),
		]);

	setPathMapping(replicatedStorage, "Packages", "Packages", packagesExist);
	shared.$className = "Folder";
	setPathMapping(shared, "Core", "src/Core/Shared", sharedCoreExists);
	shared.Features = folderNode(mappings.shared);
	setPathMapping(serverScriptService, "ServerPackages", "ServerPackages", serverPackagesExist);
	setPathMapping(serverScriptService, "Core", "src/Core/Server", serverCoreExists);
	serverScriptService.Features = folderNode(mappings.server);
	setPathMapping(
		serverScriptService,
		"ServerBootstrapper",
		"src/Startup/ServerBootstrapper.server.luau",
		serverBootstrapperExists,
	);
	setPathMapping(starterPlayerScripts, "Core", "src/Core/Client", clientCoreExists);
	starterPlayerScripts.Features = folderNode(mappings.client);
	setPathMapping(
		starterPlayerScripts,
		"ClientBootstrapper",
		"src/Startup/ClientBootstrapper.client.luau",
		clientBootstrapperExists,
	);

	await writeProjectFile(projectFileUri, contents.project, contents.originalText);
	return true;
}

async function configStartsSynchronization(workspaceFolderUri: vscode.Uri): Promise<boolean> {
	const configUri = vscode.Uri.joinPath(workspaceFolderUri, "rojo-feature-sync.toml");
	if (!(await pathExists(configUri))) {
		return false;
	}

	const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
	return /^\s*runoninit\s*=\s*true\s*(?:#.*)?$/im.test(contents);
}

function createSynchronizationSession(
	context: vscode.ExtensionContext,
	workspaceFolderUri: vscode.Uri,
): SynchronizationSession {
	const projectFileUri = vscode.Uri.joinPath(workspaceFolderUri, "default.project.json");
	const sourceWatchers = ["Features", "Core", "Startup"].map((folderName) =>
		vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceFolderUri, `src/${folderName}/**`),
		),
	);
	const packageWatchers = ["Packages", "ServerPackages"].flatMap((folderName) => [
		vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceFolderUri, folderName),
		),
		vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(workspaceFolderUri, `${folderName}/**`),
		),
	]);
	const watchers = [...sourceWatchers, ...packageWatchers];
	for (const folderName of ["Features", "Core", "Startup"]) {
		log("Info", `Watching src/${folderName}`);
	}
	log("Info", "Watching Packages and ServerPackages");
	let debounceTimer: NodeJS.Timeout | undefined;
	let syncRunning = false;
	let syncRequested = false;
	let disposed = false;

	const runRequestedSyncs = async (): Promise<void> => {
		if (syncRunning || disposed) {
			return;
		}

		syncRunning = true;
		setSyncStatus("syncing", "Synchronizing Rojo mappings");
		log("Info", "Synchronizing project...");
		try {
			do {
				syncRequested = false;
				if (!(await syncFeatureMappings(projectFileUri, workspaceFolderUri))) {
					throw new Error("Synchronization did not complete.");
				}
			} while (syncRequested && !disposed);
			setSyncStatus("ready", "Rojo mappings are synchronized");
			log("Info", "Synchronization finished");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setSyncStatus("warning", message);
			log("Error", message);
		} finally {
			syncRunning = false;
			if (syncRequested && !disposed) {
				void runRequestedSyncs();
			}
		}
	};

	const requestSync = (): void => {
		syncRequested = true;
		void runRequestedSyncs();
	};

	const scheduleSync = (): void => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(requestSync, 200);
	};

	for (const watcher of watchers) {
		watcher.onDidCreate(scheduleSync);
		watcher.onDidChange(scheduleSync);
		watcher.onDidDelete(scheduleSync);
	}

	const session: SynchronizationSession = {
		requestSync,
		dispose: () => {
			disposed = true;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			for (const watcher of watchers) {
				watcher.dispose();
			}
		},
	};
	context.subscriptions.push(session);
	return session;
}

async function startSynchronization(
	context: vscode.ExtensionContext,
	showMessage: boolean,
): Promise<boolean> {
	const workspaceFolder = getWorkspaceFolder();
	if (!workspaceFolder) {
		setSyncStatus("disabled", "No workspace folder is open");
		return false;
	}
	await migrateProject(workspaceFolder.uri);

	const projectFileUri = vscode.Uri.joinPath(workspaceFolder.uri, "default.project.json");
	const featuresFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, "src", "Features");
	if (!(await pathExists(projectFileUri)) || !(await pathExists(featuresFolderUri))) {
		setSyncStatus("warning", "Required project files are missing");
		log("Error", "Synchronization requires default.project.json and src/Features");
		if (showMessage) {
			void vscode.window.showErrorMessage(
				"Synchronization requires default.project.json and src/Features.",
			);
		}
		return false;
	}

	if (!activeSynchronization) {
		activeSynchronization = createSynchronizationSession(context, workspaceFolder.uri);
	}
	activeSynchronization.requestSync();
	if (showMessage) {
		void vscode.window.showInformationMessage("Rojo Feature Sync synchronization is active.");
	}
	return true;
}

async function syncNow(): Promise<boolean> {
	const workspaceFolder = getWorkspaceFolder();
	if (!workspaceFolder) {
		return false;
	}

	const projectFileUri = vscode.Uri.joinPath(workspaceFolder.uri, "default.project.json");
	const featuresFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, "src", "Features");
	if (!(await pathExists(projectFileUri)) || !(await pathExists(featuresFolderUri))) {
		setSyncStatus("warning", "Required project files are missing");
		void vscode.window.showErrorMessage(
			"Synchronization requires default.project.json and src/Features.",
		);
		return false;
	}

	const synchronizationWasActive = Boolean(activeSynchronization);
	if (activeSynchronization) {
		activeSynchronization.requestSync();
	} else if (!(await syncFeatureMappings(projectFileUri, workspaceFolder.uri))) {
		setSyncStatus("warning", "Synchronization failed");
		return false;
	} else {
		setSyncStatus("ready", "Rojo mappings are synchronized");
	}

	void vscode.window.showInformationMessage(
		synchronizationWasActive
			? "Rojo feature mapping synchronization requested."
			: "Rojo feature mappings synchronized.",
	);
	return true;
}

async function migrateProject(workspaceFolderUri: vscode.Uri): Promise<void> {
	const configUri = vscode.Uri.joinPath(workspaceFolderUri, "rojo-feature-sync.toml");
	if (!(await pathExists(configUri))) {
		return;
	}

	const contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
	const versionLineMatch = contents.match(/^\s*version\s*=.*$/im);
	const versionMatch = contents.match(/^\s*version\s*=\s*(\d+)\s*(?:#.*)?$/im);
	if (versionMatch && Number(versionMatch[1]) >= 1) {
		return;
	}

	log("Info", "Migrating project to configuration version 1");
	await createArchitecture(workspaceFolderUri);
	let updatedContents: string;
	if (versionLineMatch) {
		updatedContents = contents.replace(versionLineMatch[0], "version = 1");
	} else {
		updatedContents = `version = 1\n${contents}`;
	}
	await vscode.workspace.fs.writeFile(
		configUri,
		new TextEncoder().encode(`${updatedContents.replace(/\n+$/, "")}\n`),
	);
	log("Info", "Migration completed; user-created features were preserved");
}

async function renameRuntimeFolder(sourceUri: vscode.Uri, expectedName: string): Promise<void> {
	const parentUri = vscode.Uri.joinPath(sourceUri, "..");
	const entries = await vscode.workspace.fs.readDirectory(parentUri);
	if (entries.some(([name]) => name === expectedName)) {
		throw new Error(`Cannot rename: ${expectedName} already exists.`);
	}

	const targetUri = vscode.Uri.joinPath(parentUri, expectedName);
	const temporaryUri = vscode.Uri.joinPath(parentUri, `.rojo-feature-sync-${Date.now()}`);
	await vscode.workspace.fs.rename(sourceUri, temporaryUri, { overwrite: false });
	try {
		await vscode.workspace.fs.rename(temporaryUri, targetUri, { overwrite: false });
	} catch (error) {
		await vscode.workspace.fs.rename(temporaryUri, sourceUri, { overwrite: false });
		throw error;
	}
	log("Info", `Renamed runtime folder to ${expectedName}`);
}

const runtimeCodeActionProvider: vscode.CodeActionProvider = {
	provideCodeActions(_document, _range, context): vscode.CodeAction[] {
		const actions: vscode.CodeAction[] = [];
		for (const diagnostic of context.diagnostics) {
			if (diagnostic.code !== "runtime-casing" || !diagnostic.relatedInformation?.[0]) {
				continue;
			}
			const match = diagnostic.message.match(/expected "(Client|Server|Shared)"/);
			if (!match) {
				continue;
			}
			const expectedName = match[1];
			const action = new vscode.CodeAction(
				`Rename runtime folder to ${expectedName}`,
				vscode.CodeActionKind.QuickFix,
			);
			action.diagnostics = [diagnostic];
			action.isPreferred = true;
			action.command = {
				command: "rojo-feature-sync.fixRuntimeCasing",
				title: `Rename to ${expectedName}`,
				arguments: [diagnostic.relatedInformation[0].location.uri, expectedName],
			};
			actions.push(action);
		}
		return actions;
	},
};

async function createRuntime(): Promise<void> {
	const workspaceFolder = getWorkspaceFolder();
	if (!workspaceFolder) {
		return;
	}

	const target = await vscode.window.showQuickPick(["Feature", "Core"], {
		placeHolder: "Select the target system",
	});
	if (!target) {
		return;
	}

	let featureName: string | undefined;
	if (target === "Feature") {
		featureName = await vscode.window.showInputBox({
			prompt: "Enter the feature name",
			validateInput: (value) =>
				/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
					? undefined
					: "Use letters, numbers, underscores, or hyphens, starting with a letter.",
		});
		if (!featureName) {
			return;
		}
	}

	const runtime = await vscode.window.showQuickPick(["Client", "Server", "Shared"], {
		placeHolder: "Select the runtime",
	});
	if (!runtime) {
		return;
	}

	const runtimeUri =
		target === "Core"
			? vscode.Uri.joinPath(workspaceFolder.uri, "src", "Core", runtime)
			: vscode.Uri.joinPath(workspaceFolder.uri, "src", "Features", featureName!, runtime);
	await vscode.workspace.fs.createDirectory(runtimeUri);
	const initUri = vscode.Uri.joinPath(runtimeUri, "init.luau");
	if (runtime !== "Shared" && !(await pathExists(initUri))) {
		const moduleName = (featureName ?? `${runtime}Core`).replace(/[^A-Za-z0-9_]/g, "");
		const template = `local ${moduleName} = {}\n\nfunction ${moduleName}:Init()\nend\n\nfunction ${moduleName}:Start()\nend\n\nreturn ${moduleName}\n`;
		await vscode.workspace.fs.writeFile(initUri, new TextEncoder().encode(template));
	}
	log("Info", `Created ${target} runtime: ${featureName ? `${featureName}/` : ""}${runtime}`);
	void vscode.window.showInformationMessage(`Created ${runtime} runtime successfully.`);
}

async function refreshProjectDiagnostics(workspaceFolderUri: vscode.Uri): Promise<void> {
	await scanFeatures(workspaceFolderUri);
	const projectFileUri = vscode.Uri.joinPath(workspaceFolderUri, "default.project.json");
	if (await pathExists(projectFileUri)) {
		await readProjectFile(projectFileUri);
	} else {
		diagnosticCollection.delete(projectFileUri);
	}
}

function stopSynchronization(detail: string): void {
	if (activeSynchronization) {
		activeSynchronization.dispose();
		activeSynchronization = undefined;
		log("Info", "Synchronization watcher stopped");
	}
	setSyncStatus("disabled", detail);
}

function registerProjectMetadataWatchers(
	context: vscode.ExtensionContext,
	workspaceFolderUri: vscode.Uri,
): void {
	const configWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspaceFolderUri, "rojo-feature-sync.toml"),
	);
	const projectWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(workspaceFolderUri, "default.project.json"),
	);
	let refreshTimer: NodeJS.Timeout | undefined;

	const scheduleRefresh = (): void => {
		if (refreshTimer) {
			clearTimeout(refreshTimer);
		}
		refreshTimer = setTimeout(() => {
			void refreshProjectDiagnostics(workspaceFolderUri).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				log("Error", `Diagnostic refresh failed: ${message}`);
			});
		}, 200);
	};
	const handleConfigChange = (): void => {
		scheduleRefresh();
		if (initializationInProgress) {
			return;
		}
		void configStartsSynchronization(workspaceFolderUri)
			.then(async (shouldStart) => {
				if (shouldStart) {
					await startSynchronization(context, false);
				} else {
					stopSynchronization("Automatic synchronization is disabled in the project config");
				}
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				setSyncStatus("warning", message);
				log("Error", `Configuration reload failed: ${message}`);
			});
	};
	const handleProjectChange = (): void => {
		scheduleRefresh();
		activeSynchronization?.requestSync();
	};

	configWatcher.onDidCreate(handleConfigChange);
	configWatcher.onDidChange(handleConfigChange);
	configWatcher.onDidDelete(handleConfigChange);
	projectWatcher.onDidCreate(handleProjectChange);
	projectWatcher.onDidChange(handleProjectChange);
	projectWatcher.onDidDelete(handleProjectChange);
	context.subscriptions.push(
		configWatcher,
		projectWatcher,
		new vscode.Disposable(() => {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
			}
		}),
	);
	log("Info", "Watching rojo-feature-sync.toml and default.project.json");
}


async function initializeProject(): Promise<boolean> {
	const workspaceFolder = getWorkspaceFolder();
	if (!workspaceFolder) {
		return false;
	}

	const workspaceFolderUri = workspaceFolder.uri;
	const projectFileUri = vscode.Uri.joinPath(workspaceFolderUri, "default.project.json");
	const srcFolderUri = vscode.Uri.joinPath(workspaceFolderUri, "src");

	if (!(await pathExists(projectFileUri))) {
		void vscode.window.showErrorMessage("Could not find default.project.json in the workspace root.");
		return false;
	}

	if (!(await pathExists(srcFolderUri))) {
		void vscode.window.showErrorMessage("Could not find src folder.");
		return false;
	}

	const selection = await vscode.window.showWarningMessage(
		"Warning: This will replace and restructure your entire project. Continue?",
		{ modal: true },
		"Yes, Proceed",
		"No, Cancel",
	);
	if (selection !== "Yes, Proceed") {
		return false;
	}

	const projectContents = await readProjectFile(projectFileUri);
	if (!projectContents) {
		return false;
	}

	initializationInProgress = true;
	try {
		await vscode.workspace.fs.delete(srcFolderUri, { recursive: true });
		await createArchitecture(workspaceFolderUri);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(workspaceFolderUri, "rojo-feature-sync.toml"),
			new TextEncoder().encode("version = 1\nrunoninit = true\n"),
		);
		await updateGitIgnore(workspaceFolderUri);

		applyBaseMappings(projectContents.project);
		await writeProjectFile(projectFileUri, projectContents.project, projectContents.originalText);

		if (!(await syncFeatureMappings(projectFileUri, workspaceFolderUri))) {
			return false;
		}

		await updateSeleneConfig(workspaceFolderUri);
		void vscode.window.showInformationMessage("Rojo Feature Sync initialized successfully.");
		return true;
	} finally {
		initializationInProgress = false;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	outputChannel = vscode.window.createOutputChannel("Rojo Feature Sync");
	diagnosticCollection = vscode.languages.createDiagnosticCollection("rojo-feature-sync");
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	setSyncStatus("disabled", "Synchronization is not active");
	context.subscriptions.push(outputChannel, diagnosticCollection, statusBarItem);

	context.subscriptions.push(
		vscode.commands.registerCommand("rojo-feature-sync.initialize", async () => {
			try {
				if (await initializeProject()) {
					await startSynchronization(context, false);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Rojo Feature Sync initialization failed: ${message}`);
			}
		}),
		vscode.commands.registerCommand("rojo-feature-sync.startSynchronization", async () => {
			await startSynchronization(context, true);
		}),
		vscode.commands.registerCommand("rojo-feature-sync.syncNow", async () => {
			try {
				await syncNow();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Rojo Feature Sync failed: ${message}`);
			}
		}),
		vscode.commands.registerCommand("rojo-feature-sync.createRuntime", async () => {
			try {
				await createRuntime();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log("Error", `Failed to create runtime: ${message}`);
				void vscode.window.showErrorMessage(`Failed to create runtime: ${message}`);
			}
		}),
		vscode.commands.registerCommand(
			"rojo-feature-sync.fixRuntimeCasing",
			async (sourceUri: vscode.Uri, expectedName: string) => {
				try {
					await renameRuntimeFolder(sourceUri, expectedName);
					if (activeSynchronization) {
						activeSynchronization.requestSync();
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log("Error", `Runtime casing fix failed: ${message}`);
					void vscode.window.showErrorMessage(`Runtime casing fix failed: ${message}`);
				}
			},
		),
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file", pattern: "**/rojo-feature-sync.toml" },
			runtimeCodeActionProvider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
	);

	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder) {
		registerProjectMetadataWatchers(context, workspaceFolder.uri);
		void configStartsSynchronization(workspaceFolder.uri)
			.then(async (shouldStart) => {
				await refreshProjectDiagnostics(workspaceFolder.uri);
				if (shouldStart) {
					return startSynchronization(context, false);
				}
				setSyncStatus("disabled", "Automatic synchronization is disabled in the project config");
				log("Info", "Automatic synchronization is disabled");
				return false;
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Could not start Rojo Feature Sync: ${message}`);
			});
	}
}

export function deactivate(): void {}
