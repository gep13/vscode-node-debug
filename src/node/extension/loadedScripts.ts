/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { TreeDataProvider, TreeItem, EventEmitter, Event, ProviderResult } from 'vscode';
import { localize } from './utilities';
import { join, dirname, basename } from 'path';

//---- loaded script explorer

export class LoadedScriptsProvider implements TreeDataProvider<BaseTreeItem> {

	private _root: RootTreeItem;

	private _onDidChangeTreeData: EventEmitter<BaseTreeItem> = new EventEmitter<BaseTreeItem>();
	readonly onDidChangeTreeData: Event<BaseTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {

		this._root = new RootTreeItem();

		context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
			if (session && (session.type === 'node' || session.type === 'node2')) {
				this._root.add(session);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
			if (event.event === 'scriptLoaded' && (event.session.type === 'node' || event.session.type === 'node2')) {
				const sessionRoot = this._root.add(event.session);
				sessionRoot.addPath(event.body.path);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
			this._root.remove(session.id);
			this._onDidChangeTreeData.fire(undefined);
		}));
	}

	getChildren(node?: BaseTreeItem): ProviderResult<BaseTreeItem[]> {
		return (node || this._root).getChildren();
	}

	getTreeItem(node: BaseTreeItem): TreeItem {
		return node;
	}
}

class BaseTreeItem extends TreeItem {

	private _children: { [key: string]: BaseTreeItem; };

	constructor(label: string, state: vscode.TreeItemCollapsibleState) {
		super(label ? label : '/', state);
		this._children = {};
	}

	setPath(session: vscode.DebugSession, path: string): void {
		this.command = {
			command: 'extension.node-debug.openScript',
			arguments: [ session, path ],
			title: ''
		};
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {
		const array = Object.keys(this._children).map( key => this._children[key] );
		return array.sort((a, b) => this.compare(a, b));
	}

	createIfNeeded<T extends BaseTreeItem>(key: string, factory: () => T): T {
		let child = <T> this._children[key];
		if (!child) {
			child = factory();
			this._children[key] = child;
		}
		return child;
	}

	remove(key: string): void {
		delete this._children[key];
	}

	protected compare(a: BaseTreeItem, b: BaseTreeItem): number {
		return a.label.localeCompare(b.label);
	}
}

class RootTreeItem extends BaseTreeItem {

	private _showedMoreThanOne: boolean;

	constructor() {
		super('Root', vscode.TreeItemCollapsibleState.Expanded);
		this._showedMoreThanOne = false;
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {

		// skip sessions if there is only one
		const children = super.getChildren();
		if (Array.isArray(children)) {
			const size = children.length;
			if (!this._showedMoreThanOne && size === 1) {
				return children[0].getChildren();
			}
			this._showedMoreThanOne = size > 1;
		}
		return children;
	}

	add(session: vscode.DebugSession): SessionTreeItem {
		return this.createIfNeeded(session.id, () => new SessionTreeItem(session));
	}
}

class SessionTreeItem extends BaseTreeItem {

	private _session: vscode.DebugSession;
	private _initialized: boolean;

	constructor(session: vscode.DebugSession) {
		super(session.name, vscode.TreeItemCollapsibleState.Expanded);
		this._initialized = false;
		this._session = session;
		const dir = dirname(__filename);
		this.iconPath = {
			light: join(dir, '..', '..', '..', 'images', 'debug-light.svg'),
			dark: join(dir, '..', '..', '..', 'images', 'debug-dark.svg')
		};
	}

	getChildren(): ProviderResult<BaseTreeItem[]> {

		if (!this._initialized) {
			this._initialized = true;
			return listLoadedScripts(this._session).then(paths => {
				if (paths) {
					paths.forEach(path => this.addPath(path));
				}
				return super.getChildren();
			});
		}

		return super.getChildren();
	}

	protected compare(a: BaseTreeItem, b: BaseTreeItem): number {
		const acat = this.category(a);
		const bcat = this.category(b);
		if (acat !== bcat) {
			return acat - bcat;
		}
		return super.compare(a, b);
	}

	/**
	 * Return an ordinal number for folders
	 */
	private category(item: BaseTreeItem): number {

		// workspace scripts come at the beginning in "folder" order
		if (item instanceof FolderTreeItem) {
			return item.folder.index;
		}

		// <node_internals> come at the very end
		if (item.label === '<node_internals>') {
			return 1000;
		}

		// everything else in between
		return 999;
	}

	addPath(path: string): void {

		const fullPath = path;
		const NODE_INTERNALS = '<node_internals>';

		let x: BaseTreeItem = this;
		let state = vscode.TreeItemCollapsibleState.Collapsed;
		// map to root folders
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path));
		if (folder) {
			path = vscode.workspace.asRelativePath(path);
			path = path.substr(folder.name.length + 1);
			state = vscode.TreeItemCollapsibleState.Expanded;
			x = x.createIfNeeded(folder.name, () => new FolderTreeItem(folder, state));
		} else if (path.indexOf(NODE_INTERNALS) === 0) {
			path = path.substr(NODE_INTERNALS.length + 1);
			x = x.createIfNeeded(NODE_INTERNALS, () => new BaseTreeItem(NODE_INTERNALS, state));
		} else if (path.indexOf('/') === 0) {
			path = path.substr(1);
			x = x.createIfNeeded('/', () => new BaseTreeItem('/', state));
		}

		path.split(/[\/\\]/).forEach(segment => {
			x = x.createIfNeeded(segment, () => new BaseTreeItem(segment, state));
		});

		x.setPath(this._session, fullPath);
		x.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}

class FolderTreeItem extends BaseTreeItem {

	folder: vscode.WorkspaceFolder;

	constructor(folder: vscode.WorkspaceFolder, state: vscode.TreeItemCollapsibleState) {
		super(folder.name, state);
		this.folder = folder;
	}
}

//---- loaded script picker

export function pickLoadedScript() {

	const session = vscode.debug.activeDebugSession;

	return listLoadedScripts(session).then(paths => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('select.script', "Select a script"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};

		let items: vscode.QuickPickItem[];
		if (paths === undefined) {
			items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' } ];
		} else {
			items = paths.map(path => {
				return {
					label: basename(path),
					description: path };
			}).sort((a, b) => a.label.localeCompare(b.label));
		}

		vscode.window.showQuickPick(items, options).then(item => {
			if (item && item.description) {
				openScript(session, item.description);
			}
		});
	});
}

interface OldScriptItem {
	label: string;
	description: string;
	source: {
		name: string,
		path: string
	};
}

function listLoadedScripts(session: vscode.DebugSession | undefined) : Thenable<string[] | undefined> {

	if (session) {
		return session.customRequest('getLoadedScripts').then(reply => {

			if (reply.loadedScripts) {
				const old = <OldScriptItem[]> reply.loadedScripts;
				return old.filter(item => !!item.description).map(item => item.description);
			} else {
				return reply.paths;
			}

		}, err => {
			return undefined;
		});
	} else {
		return Promise.resolve(undefined);
	}
}

export function openScript(session: vscode.DebugSession, path: string) {
	let uri = vscode.Uri.parse(`debug:${path}?session=${session.id}`);
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
