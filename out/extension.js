"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const pg_1 = require("pg");
const jsonc_parser_1 = require("jsonc-parser");
// Live webviews, so token colors can be re-pushed when the user changes theme.
const liveWebviews = new Set();
function registerLiveWebview(webview) {
    liveWebviews.add(webview);
}
function broadcastThemeColors() {
    const vars = tokenColorVars();
    for (const webview of liveWebviews) {
        void webview.postMessage({ type: 'themeColors', vars });
    }
}
function broadcastDbFileChanged() {
    for (const webview of liveWebviews) {
        void webview.postMessage({ type: 'dbFileChanged' });
    }
}
function watchSqliteFile(filePath, onChange) {
    const pattern = new vscode.RelativePattern(path.dirname(filePath), `${path.basename(filePath)}{,-wal,-shm,-journal}`);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const debounced = debounce(onChange, 150);
    watcher.onDidChange(debounced);
    watcher.onDidCreate(debounced);
    return watcher;
}
function debounce(fn, wait) {
    let timer;
    return () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(fn, wait);
    };
}
function activate(context) {
    const connections = new ConnectionRegistry();
    const tree = new DatabaseTreeProvider(connections);
    const panels = new TablePanelManager(context, connections);
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => broadcastThemeColors()));
    context.subscriptions.push(vscode.window.registerTreeDataProvider('database-viewer.connections', tree), vscode.commands.registerCommand('database-viewer.openSqlite', async (uri) => {
        const file = uri ?? (await pickSqliteFile());
        if (!file) {
            return undefined;
        }
        const existing = connections.all().find((connection) => connection.kind === 'sqlite' && connection.database instanceof SqliteDriver && connection.database.filePath === file.fsPath);
        if (existing) {
            return existing;
        }
        const driver = await SqliteDriver.open(context, file.fsPath);
        const connection = {
            id: makeId('sqlite'),
            label: path.basename(file.fsPath),
            kind: 'sqlite',
            database: driver,
        };
        connections.add(connection);
        const watcher = watchSqliteFile(file.fsPath, () => {
            tree.refresh();
            broadcastDbFileChanged();
        });
        context.subscriptions.push(watcher);
        tree.refresh();
        return connection;
    }), vscode.commands.registerCommand('database-viewer.connectPostgres', async () => {
        const connection = await promptForPostgresConnection();
        if (!connection) {
            return;
        }
        const driver = await PostgresDriver.connect(connection);
        connections.add({
            id: makeId('postgres'),
            label: connection.label,
            kind: 'postgres',
            database: driver,
        });
        tree.refresh();
    }), vscode.commands.registerCommand('database-viewer.refresh', () => tree.refresh()), vscode.commands.registerCommand('database-viewer.openTable', (arg) => panels.open(arg instanceof TableNode ? arg.table : arg)), vscode.commands.registerCommand('database-viewer.disconnect', async (node) => {
        if (node instanceof ConnectionNode) {
            await connections.remove(node.connection.id);
            tree.refresh();
        }
    }), vscode.window.registerCustomEditorProvider('database-viewer.sqliteEditor', new SqliteCustomEditorProvider(tree, context.extensionUri), { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }), { dispose: () => void connections.dispose() });
}
class SqliteCustomEditorProvider {
    tree;
    extensionUri;
    constructor(tree, extensionUri) {
        this.tree = tree;
        this.extensionUri = extensionUri;
    }
    openCustomDocument(uri) {
        return { uri, dispose: () => { } };
    }
    async resolveCustomEditor(document, webviewPanel) {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
                vscode.Uri.joinPath(this.extensionUri, 'media'),
            ],
        };
        webviewPanel.webview.html = getLoadingHtml();
        let connection;
        try {
            connection = await vscode.commands.executeCommand('database-viewer.openSqlite', document.uri);
        }
        catch (error) {
            webviewPanel.webview.html = getErrorHtml(error instanceof Error ? error.message : String(error));
            return;
        }
        if (!connection) {
            webviewPanel.webview.html = getErrorHtml('Could not open the database.');
            return;
        }
        const tables = await connection.database.listTables();
        webviewPanel.webview.html = getExplorerHtml(webviewPanel.webview, this.extensionUri, connection, tables);
        registerLiveWebview(webviewPanel.webview);
        webviewPanel.onDidDispose(() => liveWebviews.delete(webviewPanel.webview));
        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                await this.handleMessage(webviewPanel, connection, message);
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                await webviewPanel.webview.postMessage({ type: 'error', message: text });
                vscode.window.showErrorMessage(text);
            }
        });
    }
    async handleMessage(webviewPanel, connection, message) {
        if (message.type === 'listTables') {
            const tables = await connection.database.listTables();
            await webviewPanel.webview.postMessage({ type: 'tables', tables });
        }
        if (message.type === 'load') {
            const data = await connection.database.getTableData(message.table, message.limit, message.offset, message.filters);
            await webviewPanel.webview.postMessage({ type: 'data', data, table: message.table, offset: message.offset, limit: message.limit, seq: message.seq });
        }
        if (message.type === 'update') {
            await connection.database.updateRow(message.table, message.primaryKeys, message.changes);
            await webviewPanel.webview.postMessage({ type: 'saved' });
        }
        if (message.type === 'insert') {
            await connection.database.insertRow(message.table, message.row);
            await webviewPanel.webview.postMessage({ type: 'saved' });
        }
        if (message.type === 'delete') {
            await connection.database.deleteRow(message.table, message.primaryKeys);
            await webviewPanel.webview.postMessage({ type: 'saved' });
        }
    }
}
function deactivate() { }
class ConnectionRegistry {
    items = new Map();
    all() {
        return [...this.items.values()];
    }
    get(id) {
        return this.items.get(id);
    }
    add(connection) {
        this.items.set(connection.id, connection);
    }
    async remove(id) {
        const connection = this.items.get(id);
        if (connection) {
            await connection.database.dispose();
            this.items.delete(id);
        }
    }
    async dispose() {
        await Promise.all([...this.items.keys()].map((id) => this.remove(id)));
    }
}
class SqliteDriver {
    filePath;
    database;
    kind = 'sqlite';
    constructor(filePath, database) {
        this.filePath = filePath;
        this.database = database;
    }
    static async open(_context, filePath) {
        const database = new better_sqlite3_1.default(filePath, { readonly: false, fileMustExist: true });
        database.pragma('journal_mode = WAL');
        return new SqliteDriver(filePath, database);
    }
    async listTables() {
        const rows = this.select("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name");
        return rows.map((row) => ({ connectionId: '', name: row.name }));
    }
    async getTableData(table, limit, offset, filters) {
        const columns = this.getColumns(table.name);
        const params = [];
        const where = this.buildSqliteFilterClause(filters, params);
        const rows = this.select(`select * from ${quoteSqlite(table.name)}${where} limit ? offset ?`, [...params, limit, offset]);
        const countRows = this.select(`select count(*) as count from ${quoteSqlite(table.name)}${where}`, params);
        const totalRows = Number(countRows[0]?.count ?? rows.length);
        return {
            columns,
            rows: normalizeRows(rows),
            primaryKeys: columns.filter((column) => column.primaryKey).map((column) => column.name),
            totalRows,
        };
    }
    async updateRow(table, primaryKeys, changes) {
        const entries = Object.entries(changes);
        if (entries.length === 0) {
            return;
        }
        const pkEntries = Object.entries(primaryKeys);
        this.run(`update ${quoteSqlite(table.name)} set ${entries.map(([key]) => `${quoteSqlite(key)} = ?`).join(', ')} where ${whereClauseSqlite(pkEntries)}`, [...entries.map(([, value]) => toSqlValue(value)), ...pkEntries.map(([, value]) => toSqlValue(value))]);
    }
    async insertRow(table, row) {
        const entries = Object.entries(row).filter(([, value]) => value !== undefined);
        if (entries.length === 0) {
            return;
        }
        this.run(`insert into ${quoteSqlite(table.name)} (${entries.map(([key]) => quoteSqlite(key)).join(', ')}) values (${entries.map(() => '?').join(', ')})`, entries.map(([, value]) => toSqlValue(value)));
    }
    async deleteRow(table, primaryKeys) {
        const pkEntries = Object.entries(primaryKeys);
        this.run(`delete from ${quoteSqlite(table.name)} where ${whereClauseSqlite(pkEntries)}`, pkEntries.map(([, value]) => toSqlValue(value)));
    }
    async dispose() {
        this.database.close();
    }
    getColumns(tableName) {
        return this.select(`pragma table_info(${quoteSqlite(tableName)})`)
            .map((row) => ({
            name: row.name,
            type: row.type || 'value',
            nullable: !row.notnull,
            primaryKey: row.pk > 0,
        }));
    }
    buildSqliteFilterClause(filters, params) {
        const clauses = filters
            .map((filter) => this.buildSqliteFilterCondition(filter, params))
            .filter((clause) => clause !== null);
        return clauses.length ? ` where ${clauses.join(' and ')}` : '';
    }
    buildSqliteFilterCondition(filter, params) {
        const column = quoteSqlite(filter.column);
        switch (filter.operator) {
            case 'is_null':
                return `${column} is null`;
            case 'is_not_null':
                return `${column} is not null`;
            case 'is_true':
                return `${column} = 1`;
            case 'is_false':
                return `${column} = 0`;
            case 'contains':
                if (!filter.value) {
                    return null;
                }
                params.push(`%${filter.value}%`);
                return `cast(${column} as text) like ?`;
            case 'not_contains':
                if (!filter.value) {
                    return null;
                }
                params.push(`%${filter.value}%`);
                return `(${column} is null or cast(${column} as text) not like ?)`;
            case 'equals':
                if (filter.value === undefined || filter.value === '') {
                    return null;
                }
                params.push(filter.value);
                return `cast(${column} as text) = ?`;
            case 'not_equals':
                if (filter.value === undefined || filter.value === '') {
                    return null;
                }
                params.push(filter.value);
                return `(${column} is null or cast(${column} as text) != ?)`;
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte': {
                if (filter.value === undefined || filter.value === '' || Number.isNaN(Number(filter.value))) {
                    return null;
                }
                const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.operator];
                params.push(Number(filter.value));
                return `${column} ${op} ?`;
            }
            default:
                return null;
        }
    }
    select(sql, params = []) {
        return this.database.prepare(sql).all(...params);
    }
    run(sql, params = []) {
        this.database.prepare(sql).run(...params);
    }
}
class PostgresDriver {
    client;
    kind = 'postgres';
    constructor(client) {
        this.client = client;
    }
    static async connect(options) {
        const client = new pg_1.Client(options);
        await client.connect();
        return new PostgresDriver(client);
    }
    async listTables() {
        const result = await this.client.query(`select table_schema, table_name
			 from information_schema.tables
			 where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
			 order by table_schema, table_name`);
        return result.rows.map((row) => ({ connectionId: '', schema: row.table_schema, name: row.table_name }));
    }
    async getTableData(table, limit, offset, filters) {
        const columns = await this.getColumns(table);
        const filterParams = [];
        const where = this.buildPostgresFilterClause(filters, filterParams);
        const result = await this.client.query(`select * from ${quotePgTable(table)}${where} limit $${filterParams.length + 1} offset $${filterParams.length + 2}`, [...filterParams, limit, offset]);
        const count = await this.client.query(`select count(*) as count from ${quotePgTable(table)}${where}`, filterParams);
        const totalRows = Number(count.rows[0]?.count ?? result.rows.length);
        return {
            columns,
            rows: normalizeRows(result.rows),
            primaryKeys: columns.filter((column) => column.primaryKey).map((column) => column.name),
            totalRows,
        };
    }
    async updateRow(table, primaryKeys, changes) {
        const entries = Object.entries(changes);
        if (entries.length === 0) {
            return;
        }
        const values = [...entries.map(([, value]) => value), ...Object.values(primaryKeys)];
        const setSql = entries.map(([key], index) => `${quotePg(key)} = $${index + 1}`).join(', ');
        const whereSql = Object.keys(primaryKeys).map((key, index) => `${quotePg(key)} = $${entries.length + index + 1}`).join(' and ');
        await this.client.query(`update ${quotePgTable(table)} set ${setSql} where ${whereSql}`, values);
    }
    async insertRow(table, row) {
        const entries = Object.entries(row).filter(([, value]) => value !== undefined);
        if (entries.length === 0) {
            return;
        }
        await this.client.query(`insert into ${quotePgTable(table)} (${entries.map(([key]) => quotePg(key)).join(', ')}) values (${entries.map((_, index) => `$${index + 1}`).join(', ')})`, entries.map(([, value]) => value));
    }
    async deleteRow(table, primaryKeys) {
        const entries = Object.entries(primaryKeys);
        await this.client.query(`delete from ${quotePgTable(table)} where ${entries.map(([key], index) => `${quotePg(key)} = $${index + 1}`).join(' and ')}`, entries.map(([, value]) => value));
    }
    async dispose() {
        await this.client.end();
    }
    async getColumns(table) {
        const result = await this.client.query(`select c.column_name as name,
					c.data_type,
					c.is_nullable,
					coalesce(kcu.column_name is not null, false) as is_primary
			 from information_schema.columns c
			 left join information_schema.table_constraints tc
				on tc.table_schema = c.table_schema
				and tc.table_name = c.table_name
				and tc.constraint_type = 'PRIMARY KEY'
			 left join information_schema.key_column_usage kcu
				on kcu.constraint_name = tc.constraint_name
				and kcu.table_schema = c.table_schema
				and kcu.table_name = c.table_name
				and kcu.column_name = c.column_name
			 where c.table_schema = $1 and c.table_name = $2
			 order by c.ordinal_position`, [table.schema ?? 'public', table.name]);
        return result.rows.map((row) => ({
            name: row.name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
            primaryKey: row.is_primary,
        }));
    }
    buildPostgresFilterClause(filters, params) {
        const clauses = filters
            .map((filter) => this.buildPostgresFilterCondition(filter, params))
            .filter((clause) => clause !== null);
        return clauses.length ? ` where ${clauses.join(' and ')}` : '';
    }
    buildPostgresFilterCondition(filter, params) {
        const column = quotePg(filter.column);
        switch (filter.operator) {
            case 'is_null':
                return `${column} is null`;
            case 'is_not_null':
                return `${column} is not null`;
            case 'is_true':
                return `${column} = true`;
            case 'is_false':
                return `${column} = false`;
            case 'contains':
                if (!filter.value) {
                    return null;
                }
                params.push(`%${filter.value}%`);
                return `cast(${column} as text) ilike $${params.length}`;
            case 'not_contains':
                if (!filter.value) {
                    return null;
                }
                params.push(`%${filter.value}%`);
                return `(${column} is null or cast(${column} as text) not ilike $${params.length})`;
            case 'equals':
                if (filter.value === undefined || filter.value === '') {
                    return null;
                }
                params.push(filter.value);
                return `cast(${column} as text) = $${params.length}`;
            case 'not_equals':
                if (filter.value === undefined || filter.value === '') {
                    return null;
                }
                params.push(filter.value);
                return `(${column} is null or cast(${column} as text) != $${params.length})`;
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte': {
                if (filter.value === undefined || filter.value === '' || Number.isNaN(Number(filter.value))) {
                    return null;
                }
                const op = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[filter.operator];
                params.push(Number(filter.value));
                return `${column} ${op} $${params.length}`;
            }
            default:
                return null;
        }
    }
}
class DatabaseTreeProvider {
    connections;
    changed = new vscode.EventEmitter();
    onDidChangeTreeData = this.changed.event;
    constructor(connections) {
        this.connections = connections;
    }
    refresh() {
        this.changed.fire(undefined);
    }
    getTreeItem(element) {
        return element;
    }
    async getChildren(element) {
        if (!element) {
            const items = this.connections.all();
            return items.length ? items.map((connection) => new ConnectionNode(connection)) : [new EmptyNode()];
        }
        if (element instanceof ConnectionNode) {
            const tables = await element.connection.database.listTables();
            return tables.map((table) => new TableNode({ ...table, connectionId: element.connection.id }));
        }
        return [];
    }
}
class ConnectionNode extends vscode.TreeItem {
    connection;
    constructor(connection) {
        super(connection.label, vscode.TreeItemCollapsibleState.Expanded);
        this.connection = connection;
        this.description = connection.kind;
        this.contextValue = 'databaseConnection';
        this.iconPath = new vscode.ThemeIcon(connection.kind === 'sqlite' ? 'database' : 'server-environment');
    }
}
class TableNode extends vscode.TreeItem {
    table;
    constructor(table) {
        super(table.schema ? `${table.schema}.${table.name}` : table.name, vscode.TreeItemCollapsibleState.None);
        this.table = table;
        this.contextValue = 'databaseTable';
        this.iconPath = new vscode.ThemeIcon('table');
        this.command = {
            command: 'database-viewer.openTable',
            title: 'Open Table',
            arguments: [table],
        };
    }
}
class EmptyNode extends vscode.TreeItem {
    constructor() {
        super('Open a SQLite file or connect to PostgreSQL', vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('info');
    }
}
class TablePanelManager {
    context;
    connections;
    panels = new Map();
    constructor(context, connections) {
        this.context = context;
        this.connections = connections;
    }
    async open(table) {
        const key = `${table.connectionId}:${table.schema ?? ''}.${table.name}`;
        const existing = this.panels.get(key);
        if (existing) {
            existing.reveal();
            return;
        }
        const panel = vscode.window.createWebviewPanel('databaseViewerTable', table.schema ? `${table.schema}.${table.name}` : table.name, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
        this.panels.set(key, panel);
        registerLiveWebview(panel.webview);
        panel.onDidDispose(() => { this.panels.delete(key); liveWebviews.delete(panel.webview); });
        panel.webview.html = getTableHtml(panel.webview, this.context.extensionUri, table);
        panel.webview.onDidReceiveMessage(async (message) => {
            try {
                await this.handleMessage(panel, table, message);
            }
            catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                await panel.webview.postMessage({ type: 'error', message: text });
                vscode.window.showErrorMessage(text);
            }
        });
    }
    async handleMessage(panel, table, message) {
        const connection = this.connections.get(table.connectionId);
        if (!connection) {
            throw new Error('Connection is no longer available.');
        }
        if (message.type === 'load') {
            const data = await connection.database.getTableData(table, message.limit, message.offset, message.filters);
            await panel.webview.postMessage({ type: 'data', data, offset: message.offset, limit: message.limit, seq: message.seq });
        }
        if (message.type === 'update') {
            await connection.database.updateRow(table, message.primaryKeys, message.changes);
            await panel.webview.postMessage({ type: 'saved' });
        }
        if (message.type === 'insert') {
            await connection.database.insertRow(table, message.row);
            await panel.webview.postMessage({ type: 'saved' });
        }
        if (message.type === 'delete') {
            await connection.database.deleteRow(table, message.primaryKeys);
            await panel.webview.postMessage({ type: 'saved' });
        }
    }
}
function getLoadingHtml() {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);">Opening database…</body></html>`;
}
function getErrorHtml(message) {
    return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-family:var(--vscode-font-family);color:var(--vscode-errorForeground);">${escapeHtml(message)}</body></html>`;
}
const gridStyles = `
	:root { color-scheme: dark light; }
	* { box-sizing: border-box; }
	html, body { margin: 0; height: 100%; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
	body { display: flex; flex-direction: column; }
	.toolbar { height: 40px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid var(--vscode-panel-border); }
	.toolbar .title { font-weight: 600; margin-right: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	input, select { height: 26px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 0 8px; border-radius: 3px; font: inherit; }
	button.icon-btn { width: 26px; height: 26px; flex: none; display: inline-grid; place-items: center; color: var(--vscode-foreground); background: transparent; border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
	button.icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
	button.icon-btn:disabled { opacity: .35; cursor: default; }
	button.icon-btn:disabled:hover { background: transparent; }
	.status { margin-left: auto; color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 12px; }
	.filter-summary { flex: none; display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
	.filter-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 6px 3px 10px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; white-space: nowrap; }
	.filter-chip button { width: 16px; height: 16px; flex: none; display: inline-grid; place-items: center; border: 0; border-radius: 50%; background: transparent; color: inherit; cursor: pointer; opacity: .8; }
	.filter-chip button:hover { opacity: 1; background: rgba(255,255,255,.15); }
	.filter-chip .codicon { font-size: 11px; }
	.grid-scroll { flex: 1; overflow: auto; position: relative; }
	table.grid-head { border-collapse: separate; border-spacing: 0; table-layout: fixed; position: sticky; top: 0; z-index: 2; }
	.grid-head th { text-align: left; color: var(--vscode-sideBarTitle-foreground); background: var(--vscode-sideBar-background); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); padding: 6px 10px; white-space: nowrap; overflow: hidden; position: relative; }
	.grid-head th .col-name { display: inline-flex; align-items: center; gap: 5px; }
	.grid-head th .col-type { display: block; font-weight: 400; font-size: 10px; text-transform: lowercase; color: var(--vscode-descriptionForeground); margin-top: 1px; }
	.grid-head th .codicon-key { color: var(--vscode-symbolIcon-keyForeground, var(--vscode-foreground)); font-size: 12px; }
	.col-filter-btn { width: 16px; height: 16px; padding: 0; display: inline-grid; place-items: center; border: 0; border-radius: 3px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; opacity: 0; }
	.grid-head th:hover .col-filter-btn, .col-filter-btn.active { opacity: 1; }
	.col-filter-btn .codicon { font-size: 12px; }
	.col-filter-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
	.col-filter-btn.active { color: var(--vscode-focusBorder); }
	.col-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; }
	.col-resizer:hover { background: var(--vscode-focusBorder); opacity: .6; }
	.filter-popover { position: fixed; z-index: 200; display: flex; flex-direction: column; gap: 8px; width: 280px; padding: 10px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
	.filter-condition-list { display: flex; flex-direction: column; gap: 6px; }
	.filter-condition-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; align-items: center; }
	.filter-condition-row select, .filter-condition-row input { width: 100%; min-width: 0; }
	.filter-condition-row .icon-btn { width: 22px; height: 22px; }
	.filter-add-btn { display: flex; align-items: center; justify-content: center; gap: 6px; }
	#grid-spacer { position: relative; }
	table.grid-body-table { border-collapse: separate; border-spacing: 0; table-layout: fixed; position: absolute; top: 0; left: 0; will-change: transform; }
	.grid-body-table td { border-bottom: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border); padding: 4px 10px; height: 26px; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--vscode-editor-background); cursor: default; }
	.grid-body-table tr:nth-child(even) td { background: var(--vscode-list-inactiveSelectionBackground); }
	.grid-body-table td[contenteditable="true"]:focus { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-input-background); white-space: normal; }
	.grid-body-table td.null-value { color: var(--vscode-descriptionForeground); font-style: italic; }
	.grid-body-table tr.skeleton-row td { background: var(--vscode-editor-background); opacity: .35; }
	.actions-col { width: 36px; min-width: 36px; max-width: 36px; text-align: center; position: sticky; left: 0; z-index: 1; background: var(--vscode-sideBar-background) !important; padding: 0 !important; }
	.actions-col button { width: 22px; height: 22px; }
	.grid-head .actions-col { z-index: 3; }
	.empty-state { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
	.loading-more { position: sticky; bottom: 0; left: 0; padding: 6px 10px; color: var(--vscode-descriptionForeground); font-size: 12px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); z-index: 4; }
	.cell-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex; align-items: center; justify-content: center; z-index: 100; }
	.cell-modal { width: min(720px, 90vw); max-height: 80vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
	.cell-modal-header { display: flex; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
	.cell-modal-header .col-name { font-weight: 600; }
	.cell-modal-header .col-type-tag { margin-left: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
	.cell-modal-header .lang-tag { margin-left: 8px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.cell-modal-header .lang-tag:empty { display: none; }
	.cell-modal-header button { margin-left: auto; }
	.cell-modal-body { flex: 1; overflow: hidden; padding: 14px; display: flex; }
	.cell-editor { position: relative; flex: 1; min-height: 220px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; overflow: hidden; background: var(--vscode-input-background); }
	.cell-editor .cell-highlight, .cell-editor textarea { margin: 0; padding: 10px; border: 0; width: 100%; height: 100%; font: 12px/1.5 var(--vscode-editor-font-family, monospace); tab-size: 2; white-space: pre; word-wrap: normal; overflow: auto; box-sizing: border-box; }
	.cell-editor .cell-highlight { position: absolute; inset: 0; pointer-events: none; color: var(--vscode-input-foreground); z-index: 0; }
	.cell-editor textarea { position: relative; z-index: 1; resize: none; background: transparent; color: transparent; caret-color: var(--vscode-editorCursor-foreground, var(--vscode-input-foreground)); outline: none; }
	.cell-editor textarea::selection { background: var(--vscode-editor-selectionBackground); }
	.cell-editor textarea:focus { outline: none; }
	.cell-editor:focus-within { outline: 1px solid var(--vscode-focusBorder); }
	.cell-modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border); }
	.btn { height: 28px; padding: 0 12px; border-radius: 3px; cursor: pointer; font: inherit; border: 0; }
	.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
	.btn.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
	.btn.secondary:hover { background: var(--vscode-toolbar-hoverBackground); }
	/* Syntax token colors resolved from the user's active theme in the extension host
	   and injected as :root --tok-* variables (with a per-kind fallback set). */
	.hljs-comment, .hljs-quote { color: var(--tok-comment); font-style: italic; }
	.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-literal, .hljs-doctag { color: var(--tok-keyword); }
	.hljs-string, .hljs-symbol, .hljs-bullet, .hljs-addition, .hljs-regexp, .hljs-selector-attr, .hljs-selector-pseudo { color: var(--tok-string); }
	.hljs-number { color: var(--tok-number); }
	.hljs-title, .hljs-title.function_, .hljs-section, .hljs-selector-id, .hljs-selector-class { color: var(--tok-function); }
	.hljs-attr, .hljs-variable, .hljs-template-variable, .hljs-property, .hljs-params { color: var(--tok-variable); }
	.hljs-type, .hljs-title.class_, .hljs-class .hljs-title { color: var(--tok-type); }
	.hljs-name, .hljs-tag { color: var(--tok-tag); }
	.hljs-attribute { color: var(--tok-attr); }
	.hljs-meta { color: var(--tok-meta); }
	.hljs-deletion { color: var(--vscode-errorForeground); }
	.hljs-emphasis { font-style: italic; }
	.hljs-strong { font-weight: bold; }
`;
const gridScript = `
	const vscode = acquireVsCodeApi();
	const ROW_HEIGHT = 26;
	const OVERSCAN = 15;
	const gridState = {
		columns: [], primaryKeys: [], columnFilters: {}, totalRows: 0, columnWidths: {},
		rowsByIndex: new Map(), pendingRanges: [], requestSeq: 0,
	};
	let hooks = null;

	function columnCategory(type) {
		const t = (type || '').toLowerCase();
		if (t.includes('bool')) { return 'boolean'; }
		if (t.includes('int') || t.includes('real') || t.includes('float') || t.includes('double') || t.includes('numeric') || t.includes('decimal') || t.includes('serial')) { return 'number'; }
		return 'text';
	}

	const OPERATORS_BY_CATEGORY = {
		text: [
			{ value: 'contains', label: 'Contains' },
			{ value: 'not_contains', label: 'Does not contain' },
			{ value: 'equals', label: 'Equals' },
			{ value: 'not_equals', label: 'Does not equal' },
			{ value: 'is_null', label: 'Is empty (NULL)' },
			{ value: 'is_not_null', label: 'Is not empty' },
		],
		number: [
			{ value: 'equals', label: '=' },
			{ value: 'not_equals', label: '≠' },
			{ value: 'gt', label: '>' },
			{ value: 'gte', label: '≥' },
			{ value: 'lt', label: '<' },
			{ value: 'lte', label: '≤' },
			{ value: 'is_null', label: 'Is empty (NULL)' },
			{ value: 'is_not_null', label: 'Is not empty' },
		],
		boolean: [
			{ value: 'is_true', label: 'Is true' },
			{ value: 'is_false', label: 'Is false' },
			{ value: 'is_null', label: 'Is empty (NULL)' },
			{ value: 'is_not_null', label: 'Is not empty' },
		],
	};

	const VALUE_LESS_OPERATORS = new Set(['is_true', 'is_false', 'is_null', 'is_not_null']);
	let filterIdSeq = 0;

	function isFilterComplete(filter) {
		return VALUE_LESS_OPERATORS.has(filter.operator) || (filter.value !== undefined && filter.value !== '');
	}

	function completedFilters() {
		return Object.values(gridState.columnFilters).flat().filter(isFilterComplete);
	}

	function activeFilters() {
		return completedFilters().map((filter) => ({ column: filter.column, operator: filter.operator, value: filter.value }));
	}

	function operatorLabel(column, operator) {
		const category = columnCategory(column.type);
		const match = OPERATORS_BY_CATEGORY[category].find((op) => op.value === operator);
		return match ? match.label : operator;
	}

	function removeFilter(columnName, filterId) {
		const list = gridState.columnFilters[columnName];
		if (!list) { return; }
		gridState.columnFilters[columnName] = list.filter((filter) => filter.id !== filterId);
		if (gridState.columnFilters[columnName].length === 0) { delete gridState.columnFilters[columnName]; }
		reload();
	}

	function renderFilterSummary() {
		const bar = document.getElementById('filter-summary');
		if (!bar) { return; }
		const complete = completedFilters();
		bar.innerHTML = '';
		bar.hidden = complete.length === 0;
		for (const filter of complete) {
			const chip = document.createElement('span');
			chip.className = 'filter-chip';
			const column = gridState.columns.find((c) => c.name === filter.column);
			const label = filter.column + ' ' + (column ? operatorLabel(column, filter.operator).toLowerCase() : filter.operator) +
				(VALUE_LESS_OPERATORS.has(filter.operator) ? '' : ' "' + filter.value + '"');
			chip.innerHTML = '<span>' + escapeForHtml(label) + '</span>';
			const removeBtn = document.createElement('button');
			removeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
			removeBtn.title = 'Remove filter';
			removeBtn.addEventListener('click', () => removeFilter(filter.column, filter.id));
			chip.appendChild(removeBtn);
			bar.appendChild(chip);
		}
	}

	function escapeForHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}

	function initGrid(nextHooks) {
		hooks = nextHooks;
		gridState.columns = [];
		gridState.primaryKeys = [];
		gridState.columnFilters = {};
		gridState.columnWidths = {};
		document.getElementById('refresh').addEventListener('click', () => reload());
		document.getElementById('add').addEventListener('click', addRow);
		hooks.getScrollEl().addEventListener('scroll', onScroll);
		window.addEventListener('resize', onScroll);
		reload();
	}

	function reload() {
		gridState.rowsByIndex = new Map();
		gridState.pendingRanges = [];
		gridState.totalRows = 0;
		gridState.requestSeq++;
		setStatus('Loading…');
		renderFilterSummary();
		fetchRange(0, Math.max(1, Math.ceil(hooks.getScrollEl().clientHeight / ROW_HEIGHT) + OVERSCAN), true);
	}

	let scrollRaf = 0;
	function onScroll() {
		if (scrollRaf) { return; }
		scrollRaf = requestAnimationFrame(() => {
			scrollRaf = 0;
			scheduleVisibleFetch();
			renderVisible();
		});
	}

	function scheduleVisibleFetch() {
		const el = hooks.getScrollEl();
		const first = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const last = Math.min(gridState.totalRows - 1, Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + OVERSCAN);
		if (last < first) { return; }

		let rangeStart = -1;
		for (let i = first; i <= last; i++) {
			const missing = !gridState.rowsByIndex.has(i) && !isPending(i);
			if (missing && rangeStart === -1) { rangeStart = i; }
			if (!missing && rangeStart !== -1) {
				fetchRange(rangeStart, i - rangeStart, false);
				rangeStart = -1;
			}
		}
		if (rangeStart !== -1) { fetchRange(rangeStart, last - rangeStart + 1, false); }
	}

	function isPending(index) {
		return gridState.pendingRanges.some((range) => index >= range.offset && index < range.offset + range.limit);
	}

	function fetchRange(offset, limit, isReload) {
		const seq = gridState.requestSeq;
		gridState.pendingRanges.push({ offset, limit, seq });
		toggleLoadingIndicator(true);
		hooks.postLoad(offset, limit, activeFilters(), seq);
	}

	function onData(message) {
		if (message.seq !== gridState.requestSeq) { return; }
		gridState.pendingRanges = gridState.pendingRanges.filter((range) => !(range.offset === message.offset && range.seq === message.seq));
		toggleLoadingIndicator(gridState.pendingRanges.length > 0);
		gridState.columns = message.data.columns;
		gridState.primaryKeys = message.data.primaryKeys;
		gridState.totalRows = message.data.totalRows;
		for (let i = 0; i < message.data.rows.length; i++) {
			gridState.rowsByIndex.set(message.offset + i, message.data.rows[i]);
		}
		ensureHeader();
		updateSpacerHeight();
		renderVisible();
		setStatus(gridState.rowsByIndex.size + ' of ' + gridState.totalRows + ' rows loaded');
	}

	function toggleLoadingIndicator(visible) {
		const indicator = document.getElementById('loading-more');
		if (indicator) { indicator.hidden = !visible; }
	}

	function setStatus(text) {
		const status = document.getElementById('status');
		if (status) { status.textContent = text; }
	}

	function updateSpacerHeight() {
		const spacer = document.getElementById('grid-spacer');
		const emptyState = document.getElementById('empty-state');
		if (spacer) { spacer.style.height = (gridState.totalRows * ROW_HEIGHT) + 'px'; }
		if (emptyState) { emptyState.hidden = gridState.totalRows !== 0; }
	}

	const DEFAULT_COLUMN_WIDTH = 160;
	const ACTIONS_COL_WIDTH = 36;

	function ensureHeader() {
		const headRow = document.getElementById('grid-head-row');
		if (!headRow || headRow.dataset.built === 'true') { return; }
		headRow.dataset.built = 'true';
		for (const column of gridState.columns) {
			if (!gridState.columnWidths[column.name]) {
				gridState.columnWidths[column.name] = DEFAULT_COLUMN_WIDTH;
			}
		}
		headRow.appendChild(headerActionsCell());
		for (const column of gridState.columns) {
			headRow.appendChild(headerCell(column));
		}
		applyColumnLayout();
	}

	function applyColumnLayout() {
		const widths = [ACTIONS_COL_WIDTH, ...gridState.columns.map((c) => gridState.columnWidths[c.name] || DEFAULT_COLUMN_WIDTH)];
		const total = widths.reduce((sum, w) => sum + w, 0);
		for (const colsId of ['grid-head-cols', 'grid-body-cols']) {
			const colgroup = document.getElementById(colsId);
			if (!colgroup) { continue; }
			colgroup.innerHTML = '';
			for (const w of widths) {
				const col = document.createElement('col');
				col.style.width = w + 'px';
				colgroup.appendChild(col);
			}
		}
		for (const tableId of ['grid-head', 'grid-body-table']) {
			const table = tableId === 'grid-head' ? document.querySelector('.grid-head') : document.getElementById('grid-body-table');
			if (table) { table.style.width = total + 'px'; }
		}
		const spacer = document.getElementById('grid-spacer');
		if (spacer) { spacer.style.width = total + 'px'; }
	}

	function renderVisible() {
		const el = hooks.getScrollEl();
		const bodyTable = document.getElementById('grid-body-table');
		const body = document.getElementById('grid-body');
		if (!body || !bodyTable) { return; }
		const first = Math.max(0, Math.floor(el.scrollTop / ROW_HEIGHT) - OVERSCAN);
		const last = Math.min(gridState.totalRows - 1, Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT) + OVERSCAN);

		body.innerHTML = '';
		bodyTable.style.transform = 'translateY(' + (first * ROW_HEIGHT) + 'px)';
		for (let i = first; i <= last; i++) {
			const row = gridState.rowsByIndex.get(i);
			body.appendChild(row ? renderRow(row) : renderSkeletonRow());
		}
	}

	function headerActionsCell() {
		const th = document.createElement('th');
		th.className = 'actions-col';
		return th;
	}

	function headerCell(column) {
		const th = document.createElement('th');
		const wrap = document.createElement('span');
		wrap.className = 'col-name';
		const nameSpan = document.createElement('span');
		nameSpan.textContent = column.name;
		wrap.appendChild(nameSpan);
		if (gridState.primaryKeys.includes(column.name)) {
			const key = document.createElement('span');
			key.className = 'codicon codicon-key';
			key.title = 'Primary key';
			wrap.appendChild(key);
		}
		const filterBtn = document.createElement('button');
		filterBtn.className = 'col-filter-btn';
		filterBtn.title = 'Filter ' + column.name;
		filterBtn.innerHTML = '<span class="codicon codicon-filter"></span>';
		filterBtn.addEventListener('click', (event) => {
			event.stopPropagation();
			openFilterPopover(column, filterBtn);
		});
		if (gridState.columnFilters[column.name]?.length) { filterBtn.classList.add('active'); }
		wrap.appendChild(filterBtn);
		th.appendChild(wrap);
		const typeLine = document.createElement('span');
		typeLine.className = 'col-type';
		typeLine.textContent = column.type + (column.nullable ? '' : ' · not null');
		th.appendChild(typeLine);

		const resizer = document.createElement('div');
		resizer.className = 'col-resizer';
		resizer.addEventListener('mousedown', (event) => startColumnResize(event, column.name, th));
		th.appendChild(resizer);
		return th;
	}

	let filterPopoverOutsideClickHandler = null;

	function closeFilterPopover() {
		if (filterPopoverOutsideClickHandler) {
			document.removeEventListener('mousedown', filterPopoverOutsideClickHandler);
			filterPopoverOutsideClickHandler = null;
		}
		document.querySelectorAll('.filter-popover').forEach((el) => el.remove());
	}

	function openFilterPopover(column, anchorEl) {
		closeFilterPopover();
		const category = columnCategory(column.type);
		const operators = OPERATORS_BY_CATEGORY[category];

		const popover = document.createElement('div');
		popover.className = 'filter-popover';
		popover.innerHTML = \`
			<div class="filter-condition-list" id="filter-condition-list"></div>
			<button class="btn secondary filter-add-btn" id="filter-add"><span class="codicon codicon-add"></span> Add condition</button>
		\`;
		const list = popover.querySelector('#filter-condition-list');

		function renderConditions() {
			list.innerHTML = '';
			const conditions = gridState.columnFilters[column.name] || [];
			for (const condition of conditions) {
				list.appendChild(renderConditionRow(condition));
			}
			if (conditions.length === 0) {
				list.appendChild(renderConditionRow(null));
			}
		}

		function renderConditionRow(existing) {
			const condition = existing || { id: ++filterIdSeq, column: column.name, operator: operators[0].value, value: '' };
			const isNew = !existing;

			const row = document.createElement('div');
			row.className = 'filter-condition-row';
			const operatorSelect = document.createElement('select');
			for (const op of operators) {
				const option = document.createElement('option');
				option.value = op.value;
				option.textContent = op.label;
				operatorSelect.appendChild(option);
			}
			operatorSelect.value = condition.operator;

			const valueInput = document.createElement('input');
			valueInput.placeholder = 'Value';
			if (category === 'number') { valueInput.type = 'number'; }
			valueInput.value = condition.value || '';

			function syncValueVisibility() {
				valueInput.hidden = VALUE_LESS_OPERATORS.has(operatorSelect.value);
			}
			syncValueVisibility();

			function commit() {
				condition.operator = operatorSelect.value;
				condition.value = valueInput.value;
				const list_ = gridState.columnFilters[column.name] || [];
				if (!list_.some((c) => c.id === condition.id)) { list_.push(condition); }
				gridState.columnFilters[column.name] = list_;
				if (isFilterComplete(condition)) { reload(); }
			}

			operatorSelect.addEventListener('change', () => { syncValueVisibility(); commit(); });
			valueInput.addEventListener('change', commit);
			valueInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commit(); } });

			const removeBtn = document.createElement('button');
			removeBtn.className = 'icon-btn';
			removeBtn.title = 'Remove condition';
			removeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
			removeBtn.addEventListener('click', () => {
				if (!isNew) { removeFilter(column.name, condition.id); }
				renderConditions();
			});

			row.appendChild(operatorSelect);
			row.appendChild(valueInput);
			row.appendChild(removeBtn);
			return row;
		}

		renderConditions();
		popover.querySelector('#filter-add').addEventListener('click', () => {
			list.appendChild(renderConditionRow(null));
		});

		document.body.appendChild(popover);
		const rect = anchorEl.getBoundingClientRect();
		popover.style.top = rect.bottom + 4 + 'px';
		popover.style.left = Math.min(rect.left, window.innerWidth - popover.offsetWidth - 12) + 'px';

		filterPopoverOutsideClickHandler = (event) => {
			if (!popover.contains(event.target) && event.target !== anchorEl) { closeFilterPopover(); }
		};
		setTimeout(() => document.addEventListener('mousedown', filterPopoverOutsideClickHandler), 0);
	}

	function startColumnResize(event, columnName, th) {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = th.getBoundingClientRect().width;
		function onMove(moveEvent) {
			const next = Math.max(60, startWidth + (moveEvent.clientX - startX));
			gridState.columnWidths[columnName] = next;
			applyColumnWidth(columnName, next);
		}
		function onUp() {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		}
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}

	function applyColumnWidth(columnName, width) {
		gridState.columnWidths[columnName] = width;
		applyColumnLayout();
	}

	function renderSkeletonRow() {
		const tr = document.createElement('tr');
		tr.className = 'skeleton-row';
		const actions = document.createElement('td');
		actions.className = 'actions-col';
		tr.appendChild(actions);
		for (const column of gridState.columns) {
			const td = document.createElement('td');
			tr.appendChild(td);
		}
		return tr;
	}

	function renderRow(row) {
		const tr = document.createElement('tr');
		const actions = document.createElement('td');
		actions.className = 'actions-col';
		const remove = document.createElement('button');
		remove.className = 'icon-btn';
		remove.title = 'Delete row';
		remove.innerHTML = '<span class="codicon codicon-trash"></span>';
		remove.disabled = !canEdit(row);
		remove.addEventListener('click', () => {
			hooks.postDelete(primaryKeyValues(row));
		});
		actions.appendChild(remove);
		tr.appendChild(actions);

		for (const column of gridState.columns) {
			const td = document.createElement('td');
			const value = row[column.name];
			if (value === null || value === undefined) {
				td.textContent = 'NULL';
				td.classList.add('null-value');
			} else {
				td.textContent = stringify(value);
			}
			td.title = 'Double-click to expand';
			td.addEventListener('dblclick', () => openCellModal(row, column));
			tr.appendChild(td);
		}
		return tr;
	}

	function canEdit(row) {
		return gridState.primaryKeys.length > 0 && gridState.primaryKeys.every((key) => row[key] !== null && row[key] !== undefined);
	}

	function primaryKeyValues(row) {
		return Object.fromEntries(gridState.primaryKeys.map((key) => [key, row[key]]));
	}

	function stringify(value) {
		if (value === null || value === undefined) { return ''; }
		return String(value);
	}

	function parseCell(value) {
		return value === '' ? null : value;
	}

	function detectLanguage(text) {
		if (typeof hljs === 'undefined' || !text || !text.trim()) { return null; }
		const trimmed = text.trim();
		// Fast structural checks before falling back to hljs auto-detection.
		if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
			try { JSON.parse(trimmed); return 'json'; } catch (e) { /* not valid JSON */ }
		}
		if (/^\\s*<(!doctype|html|\\?xml|[a-z][\\w-]*[\\s>\\/])/i.test(trimmed)) {
			return 'xml';
		}
		const auto = hljs.highlightAuto(trimmed, ['json', 'xml', 'javascript', 'typescript', 'sql', 'python', 'css', 'yaml', 'markdown', 'bash', 'java', 'go', 'rust', 'php', 'ruby']);
		// hljs relevance under ~5 is usually noise for plain text.
		if (auto.language && auto.relevance >= 5) { return auto.language; }
		return null;
	}

	function highlightInto(layer, text, language) {
		if (typeof hljs === 'undefined' || !language) {
			layer.textContent = text;
			layer.className = 'cell-highlight';
			return;
		}
		try {
			layer.innerHTML = hljs.highlight(text, { language, ignoreIllegal: true }).value;
		} catch (e) {
			layer.textContent = text;
		}
		layer.className = 'cell-highlight hljs';
	}

	function openCellModal(row, column) {
		const backdrop = document.createElement('div');
		backdrop.className = 'cell-modal-backdrop';
		const editable = canEdit(row);
		backdrop.innerHTML = \`
			<div class="cell-modal">
				<div class="cell-modal-header">
					<span class="col-name"></span>
					<span class="col-type-tag"></span>
					<span class="lang-tag" id="lang-tag"></span>
					<button class="icon-btn" id="close-modal"><span class="codicon codicon-close"></span></button>
				</div>
				<div class="cell-modal-body">
					<div class="cell-editor">
						<pre class="cell-highlight" id="cell-highlight" aria-hidden="true"></pre>
						<textarea id="cell-value" spellcheck="false" \${editable ? '' : 'readonly'}></textarea>
					</div>
				</div>
				<div class="cell-modal-footer">
					<button class="btn secondary" id="cancel-modal">Close</button>
					\${editable ? '<button class="btn primary" id="save-modal">Save</button>' : ''}
				</div>
			</div>
		\`;
		backdrop.querySelector('.col-name').textContent = column.name;
		backdrop.querySelector('.col-type-tag').textContent = column.type;
		const textarea = backdrop.querySelector('#cell-value');
		const highlight = backdrop.querySelector('#cell-highlight');
		const langTag = backdrop.querySelector('#lang-tag');
		const originalValue = row[column.name];
		textarea.value = originalValue === null || originalValue === undefined ? '' : stringify(originalValue);

		let language = detectLanguage(textarea.value);
		langTag.textContent = language || '';

		function refreshHighlight() {
			// Trailing newline keeps the <pre> height in sync with the textarea.
			highlightInto(highlight, textarea.value + '\\n', language);
		}
		function syncScroll() {
			highlight.scrollTop = textarea.scrollTop;
			highlight.scrollLeft = textarea.scrollLeft;
		}
		refreshHighlight();

		let redetectTimer = 0;
		textarea.addEventListener('input', () => {
			refreshHighlight();
			syncScroll();
			clearTimeout(redetectTimer);
			redetectTimer = setTimeout(() => {
				language = detectLanguage(textarea.value);
				langTag.textContent = language || '';
				refreshHighlight();
			}, 400);
		});
		textarea.addEventListener('scroll', syncScroll);

		document.body.appendChild(backdrop);
		refreshHighlight();
		textarea.focus();

		function close() { backdrop.remove(); }
		backdrop.addEventListener('click', (event) => { if (event.target === backdrop) { close(); } });
		backdrop.querySelector('#close-modal').addEventListener('click', close);
		backdrop.querySelector('#cancel-modal').addEventListener('click', close);
		const saveBtn = backdrop.querySelector('#save-modal');
		if (saveBtn) {
			saveBtn.addEventListener('click', () => {
				const next = parseCell(textarea.value);
				if (stringify(next) !== stringify(originalValue)) {
					hooks.postUpdate(primaryKeyValues(row), { [column.name]: next });
				}
				close();
			});
		}
	}

	function addRow() {
		const row = {};
		for (const column of gridState.columns) {
			const value = prompt(column.name + ' (' + column.type + ')', '');
			if (value !== null && value !== '') { row[column.name] = value; }
		}
		hooks.postInsert(row);
	}

	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message.type === 'data') {
			onData(message);
		}
		if (message.type === 'saved') {
			reload();
		}
		if (message.type === 'error') {
			toggleLoadingIndicator(false);
			setStatus(message.message);
		}
		if (message.type === 'themeColors') {
			document.documentElement.setAttribute('style', message.vars);
		}
		if (message.type === 'dbFileChanged') {
			reload();
		}
	});
`;
// TextMate scopes to try (most specific first) for each syntax role we highlight.
const TOKEN_SCOPE_MAP = {
    comment: ['comment', 'punctuation.definition.comment'],
    keyword: ['keyword', 'keyword.control', 'storage.type', 'storage.modifier'],
    string: ['string', 'string.quoted', 'punctuation.definition.string'],
    number: ['constant.numeric', 'constant.numeric.integer'],
    function: ['entity.name.function', 'support.function', 'meta.function-call'],
    variable: ['variable', 'variable.other', 'meta.definition.variable.name'],
    type: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class'],
    tag: ['entity.name.tag', 'punctuation.definition.tag'],
    attr: ['entity.other.attribute-name'],
    meta: ['meta.tag', 'punctuation', 'meta.preprocessor'],
};
const FALLBACK_TOKEN_COLORS = {
    dark: { comment: '#6a9955', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', function: '#dcdcaa', variable: '#9cdcfe', type: '#4ec9b0', tag: '#569cd6', attr: '#9cdcfe', meta: '#808080' },
    light: { comment: '#008000', keyword: '#0000ff', string: '#a31515', number: '#098658', function: '#795e26', variable: '#001080', type: '#267f99', tag: '#800000', attr: '#e50000', meta: '#808080' },
    hcDark: { comment: '#7ca668', keyword: '#569cd6', string: '#ce9178', number: '#b5cea8', function: '#dcdcaa', variable: '#9cdcfe', type: '#4ec9b0', tag: '#569cd6', attr: '#9cdcfe', meta: '#d4d4d4' },
    hcLight: { comment: '#008000', keyword: '#0000ff', string: '#a31515', number: '#098658', function: '#795e26', variable: '#001080', type: '#267f99', tag: '#800000', attr: '#e50000', meta: '#292929' },
};
function themeKindFallbackKey() {
    switch (vscode.window.activeColorTheme.kind) {
        case vscode.ColorThemeKind.Light: return 'light';
        case vscode.ColorThemeKind.HighContrast: return 'hcDark';
        case vscode.ColorThemeKind.HighContrastLight: return 'hcLight';
        default: return 'dark';
    }
}
function collectThemeRules(themeJsonPath, seen, rules) {
    if (seen.has(themeJsonPath)) {
        return;
    }
    seen.add(themeJsonPath);
    let parsed;
    try {
        parsed = (0, jsonc_parser_1.parse)(fs.readFileSync(themeJsonPath, 'utf8'));
    }
    catch {
        return;
    }
    if (!parsed) {
        return;
    }
    if (parsed.include) {
        collectThemeRules(path.join(path.dirname(themeJsonPath), parsed.include), seen, rules);
    }
    if (Array.isArray(parsed.tokenColors)) {
        rules.push(...parsed.tokenColors);
    }
}
function findActiveThemePath() {
    const label = vscode.workspace.getConfiguration('workbench').get('colorTheme');
    if (!label) {
        return undefined;
    }
    for (const extension of vscode.extensions.all) {
        const themes = extension.packageJSON?.contributes?.themes;
        if (!themes) {
            continue;
        }
        const match = themes.find((theme) => theme.id === label || theme.label === label);
        if (match) {
            return path.join(extension.extensionPath, match.path);
        }
    }
    return undefined;
}
// TextMate specificity of a theme rule against a wanted scope: a rule scope matches
// if it equals the wanted scope or is an ancestor of it (a dotted-segment prefix).
// Returns the matching rule-scope length (longer = more specific), or -1 if no match.
function scopeSpecificity(ruleScope, wanted) {
    if (!ruleScope) {
        return -1;
    }
    const scopes = Array.isArray(ruleScope) ? ruleScope : ruleScope.split(',').map((s) => s.trim());
    let best = -1;
    for (const scope of scopes) {
        if (scope === wanted || wanted.startsWith(scope + '.')) {
            best = Math.max(best, scope.length);
        }
    }
    return best;
}
function resolveTokenColors() {
    const fallback = FALLBACK_TOKEN_COLORS[themeKindFallbackKey()];
    const rules = [];
    const themePath = findActiveThemePath();
    if (themePath) {
        collectThemeRules(themePath, new Set(), rules);
    }
    // User overrides win — append last so ties break in their favor.
    const custom = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations');
    if (custom?.textMateRules) {
        rules.push(...custom.textMateRules);
    }
    const resolved = { ...fallback };
    for (const role of Object.keys(TOKEN_SCOPE_MAP)) {
        // Try candidate scopes in priority order; use the first one that any rule matches.
        // Within a candidate, the most specific rule wins (ties → later rule).
        for (const wantedScope of TOKEN_SCOPE_MAP[role]) {
            let found;
            let bestSpecificity = -1;
            for (const rule of rules) {
                if (!rule.settings?.foreground) {
                    continue;
                }
                const specificity = scopeSpecificity(rule.scope, wantedScope);
                if (specificity >= bestSpecificity && specificity >= 0) {
                    bestSpecificity = specificity;
                    found = rule.settings.foreground;
                }
            }
            if (found) {
                resolved[role] = found;
                break;
            }
        }
    }
    return resolved;
}
function tokenColorVars() {
    const c = resolveTokenColors();
    return `--tok-comment:${c.comment};--tok-keyword:${c.keyword};--tok-string:${c.string};--tok-number:${c.number};--tok-function:${c.function};--tok-variable:${c.variable};--tok-type:${c.type};--tok-tag:${c.tag};--tok-attr:${c.attr};--tok-meta:${c.meta};`;
}
function getTableHtml(webview, extensionUri, table) {
    const nonce = getNonce();
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    const hljsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'hljs.bundle.js'));
    const title = escapeHtml(table.schema ? `${table.schema}.${table.name}` : table.name);
    return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link href="${codicons}" rel="stylesheet">
	<title>${title}</title>
	<style>${gridStyles}</style>
	<style>:root{${tokenColorVars()}}</style>
	<script nonce="${nonce}" src="${hljsUri}"></script>
</head>
<body>
	<div class="toolbar">
		<span class="title">${title}</span>
		<button class="icon-btn" id="refresh" title="Refresh"><span class="codicon codicon-refresh"></span></button>
		<button class="icon-btn" id="add" title="Add row"><span class="codicon codicon-add"></span></button>
		<span class="status" id="status"></span>
	</div>
	<div class="filter-summary" id="filter-summary" hidden></div>
	<div class="grid-scroll" id="grid-scroll">
		<table class="grid-head"><colgroup id="grid-head-cols"></colgroup><tr id="grid-head-row"></tr></table>
		<div id="grid-spacer">
			<table class="grid-body-table" id="grid-body-table"><colgroup id="grid-body-cols"></colgroup><tbody id="grid-body"></tbody></table>
		</div>
		<div class="empty-state" id="empty-state" hidden>No rows found.</div>
		<div class="loading-more" id="loading-more" hidden>Loading more rows…</div>
	</div>
	<script nonce="${nonce}">
		${gridScript}
		initGrid({
			getScrollEl: () => document.getElementById('grid-scroll'),
			postLoad: (offset, limit, filters, seq) => vscode.postMessage({ type: 'load', limit, offset, filters, seq }),
			postUpdate: (primaryKeys, changes) => vscode.postMessage({ type: 'update', primaryKeys, changes }),
			postInsert: (row) => vscode.postMessage({ type: 'insert', row }),
			postDelete: (primaryKeys) => vscode.postMessage({ type: 'delete', primaryKeys }),
		});
	</script>
</body>
</html>`;
}
function getExplorerHtml(webview, extensionUri, connection, tables) {
    const nonce = getNonce();
    const codicons = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'));
    const hljsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'hljs.bundle.js'));
    const initialTables = JSON.stringify(tables).replace(/</g, '\\u003c');
    const initialLabel = JSON.stringify(connection.label).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	<link href="${codicons}" rel="stylesheet">
	<title>${escapeHtml(connection.label)}</title>
	<script nonce="${nonce}" src="${hljsUri}"></script>
	<style>
		${gridStyles}
		:root{${tokenColorVars()}}
		html, body { display: flex; flex-direction: row; overflow: hidden; }
		.sidebar { width: 240px; min-width: 160px; max-width: 480px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); }
		.sidebar-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
		.sidebar-header .codicon-database { font-size: 16px; color: var(--vscode-icon-foreground); }
		.sidebar-header .db-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
		.sidebar-header button { flex: none; width: 24px; height: 24px; display: inline-grid; place-items: center; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 3px; cursor: pointer; opacity: .8; }
		.sidebar-header button:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
		.table-count { padding: 6px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
		.table-list { flex: 1; overflow-y: auto; padding: 0 4px 8px; }
		.table-item { display: flex; align-items: center; gap: 7px; padding: 5px 8px; border-radius: 4px; cursor: pointer; color: var(--vscode-foreground); user-select: none; }
		.table-item .codicon-table { font-size: 14px; opacity: .75; }
		.table-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.table-item:hover { background: var(--vscode-list-hoverBackground); }
		.table-item.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
		.table-item.active .codicon { color: var(--vscode-list-activeSelectionForeground); }
		.sidebar-resizer { width: 4px; flex: none; cursor: col-resize; background: transparent; }
		.sidebar-resizer:hover { background: var(--vscode-focusBorder); }
		.main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; }
		.welcome { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); flex-direction: column; gap: 8px; }
		.welcome .codicon { font-size: 32px; opacity: .5; }
	</style>
</head>
<body>
	<div class="sidebar" id="sidebar">
		<div class="sidebar-header">
			<span class="codicon codicon-database"></span>
			<span class="db-name" id="db-name" title=""></span>
			<button class="icon-btn" id="refresh-tables" title="Refresh tables"><span class="codicon codicon-refresh"></span></button>
		</div>
		<div class="table-count" id="table-count"></div>
		<div class="table-list" id="table-list"></div>
	</div>
	<div class="sidebar-resizer" id="sidebar-resizer"></div>
	<div class="main" id="main">
		<div class="welcome" id="welcome">
			<span class="codicon codicon-table"></span>
			<div>Select a table to view its data</div>
		</div>
	</div>

	<script nonce="${nonce}">
		${gridScript}
		const explorerState = { connectionLabel: ${initialLabel}, tables: ${initialTables}, activeTable: null };

		const dbName = document.getElementById('db-name');
		const tableCount = document.getElementById('table-count');
		const tableList = document.getElementById('table-list');
		const main = document.getElementById('main');

		function tableKey(table) {
			return (table.schema || '') + '.' + table.name;
		}

		function renderSidebar() {
			dbName.textContent = explorerState.connectionLabel;
			dbName.title = explorerState.connectionLabel;
			tableCount.textContent = explorerState.tables.length + (explorerState.tables.length === 1 ? ' table' : ' tables');
			tableList.innerHTML = '';
			for (const table of explorerState.tables) {
				const item = document.createElement('div');
				item.className = 'table-item' + (explorerState.activeTable && tableKey(explorerState.activeTable) === tableKey(table) ? ' active' : '');
				item.innerHTML = '<span class="codicon codicon-table"></span><span class="name"></span>';
				item.querySelector('.name').textContent = table.schema ? table.schema + '.' + table.name : table.name;
				item.title = table.schema ? table.schema + '.' + table.name : table.name;
				item.addEventListener('click', () => openExplorerTable(table));
				tableList.appendChild(item);
			}
		}

		function openExplorerTable(table) {
			explorerState.activeTable = table;
			renderSidebar();
			renderMainShell(table);
			initGrid({
				getScrollEl: () => document.getElementById('grid-scroll'),
				postLoad: (offset, limit, filters, seq) => vscode.postMessage({ type: 'load', table, limit, offset, filters, seq }),
				postUpdate: (primaryKeys, changes) => vscode.postMessage({ type: 'update', table, primaryKeys, changes }),
				postInsert: (row) => vscode.postMessage({ type: 'insert', table, row }),
				postDelete: (primaryKeys) => vscode.postMessage({ type: 'delete', table, primaryKeys }),
			});
		}

		function renderMainShell(table) {
			const title = table.schema ? table.schema + '.' + table.name : table.name;
			main.innerHTML = \`
				<div class="toolbar">
					<span class="title"></span>
					<button class="icon-btn" id="refresh" title="Refresh"><span class="codicon codicon-refresh"></span></button>
					<button class="icon-btn" id="add" title="Add row"><span class="codicon codicon-add"></span></button>
					<span class="status" id="status"></span>
				</div>
				<div class="filter-summary" id="filter-summary" hidden></div>
				<div class="grid-scroll" id="grid-scroll">
					<table class="grid-head"><colgroup id="grid-head-cols"></colgroup><tr id="grid-head-row"></tr></table>
					<div id="grid-spacer">
						<table class="grid-body-table" id="grid-body-table"><colgroup id="grid-body-cols"></colgroup><tbody id="grid-body"></tbody></table>
					</div>
					<div class="empty-state" id="empty-state" hidden>No rows found.</div>
					<div class="loading-more" id="loading-more" hidden>Loading more rows…</div>
				</div>
			\`;
			main.querySelector('.title').textContent = title;
		}

		document.getElementById('refresh-tables').addEventListener('click', () => vscode.postMessage({ type: 'listTables' }));

		(function setupSidebarResize() {
			const sidebar = document.getElementById('sidebar');
			const resizer = document.getElementById('sidebar-resizer');
			resizer.addEventListener('mousedown', (event) => {
				event.preventDefault();
				const startX = event.clientX;
				const startWidth = sidebar.getBoundingClientRect().width;
				function onMove(moveEvent) {
					const next = Math.min(480, Math.max(160, startWidth + (moveEvent.clientX - startX)));
					sidebar.style.width = next + 'px';
				}
				function onUp() {
					document.removeEventListener('mousemove', onMove);
					document.removeEventListener('mouseup', onUp);
				}
				document.addEventListener('mousemove', onMove);
				document.addEventListener('mouseup', onUp);
			});
		})();

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'tables') {
				explorerState.tables = message.tables;
				renderSidebar();
			}
			if (message.type === 'dbFileChanged') {
				vscode.postMessage({ type: 'listTables' });
			}
		});

		renderSidebar();
		if (explorerState.tables.length > 0) {
			openExplorerTable(explorerState.tables[0]);
		}
	</script>
</body>
</html>`;
}
async function promptForPostgresConnection() {
    const host = await input('PostgreSQL host', 'localhost');
    if (!host) {
        return undefined;
    }
    const portText = await input('Port', '5432');
    const database = await input('Database name');
    const user = await input('User');
    const password = await input('Password', undefined, true);
    const sslChoice = await vscode.window.showQuickPick(['No SSL', 'SSL'], { title: 'PostgreSQL SSL' });
    if (!portText || !database || !user || !sslChoice) {
        return undefined;
    }
    const port = Number(portText);
    if (!Number.isInteger(port)) {
        throw new Error('PostgreSQL port must be a number.');
    }
    return {
        label: `${user}@${host}/${database}`,
        host,
        port,
        database,
        user,
        password,
        ssl: sslChoice === 'SSL' ? { rejectUnauthorized: false } : false,
    };
}
async function pickSqliteFile() {
    const files = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Open SQLite Database',
        filters: { SQLite: ['sqlite', 'sqlite3', 'db'], All: ['*'] },
    });
    return files?.[0];
}
async function input(prompt, value, password = false) {
    return vscode.window.showInputBox({ prompt, value, password, ignoreFocusOut: true });
}
function makeId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function quoteSqlite(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function quotePg(value) {
    return `"${value.replaceAll('"', '""')}"`;
}
function quotePgTable(table) {
    return `${quotePg(table.schema ?? 'public')}.${quotePg(table.name)}`;
}
function whereClauseSqlite(entries) {
    if (entries.length === 0) {
        throw new Error('This table has no primary key. Editing requires a primary key.');
    }
    return entries.map(([key]) => `${quoteSqlite(key)} = ?`).join(' and ');
}
function toSqlValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value;
    }
    if (value instanceof Buffer) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0;
    }
    return String(value);
}
// Convert driver-returned values into shapes that survive webview postMessage and
// stringify sensibly. BLOBs (Buffer/Uint8Array) become a readable hex preview.
function normalizeValue(value) {
    if (value === null || value === undefined) {
        return value;
    }
    if (value instanceof Uint8Array) {
        return formatBlob(value);
    }
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        // Arrays / JSON columns (e.g. Postgres json/jsonb) — render as JSON text.
        try {
            return JSON.stringify(value);
        }
        catch {
            return String(value);
        }
    }
    return value;
}
function formatBlob(bytes) {
    const size = bytes.byteLength;
    const previewLength = Math.min(size, 24);
    let hex = '';
    for (let i = 0; i < previewLength; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    const suffix = size > previewLength ? '…' : '';
    return `BLOB(${size} bytes) 0x${hex}${suffix}`;
}
function normalizeRows(rows) {
    return rows.map((row) => {
        const out = {};
        for (const key of Object.keys(row)) {
            out[key] = normalizeValue(row[key]);
        }
        return out;
    });
}
function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[character] ?? character));
}
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=extension.js.map