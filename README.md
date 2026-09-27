# Database Viewer

A clean, simple VS Code database viewer for SQLite files and PostgreSQL databases.

## Features

- Open `.db`, `.sqlite`, and `.sqlite3` files from the Database Viewer activity bar or Explorer context menu.
- Connect to PostgreSQL with host, port, database, user, password, and optional SSL prompts.
- Browse connections and tables from a dedicated Databases tree view.
- Open tables in an editor webview with paging, filtering, refresh, insert, update, and delete controls.
- Edit cells directly in the grid. Updates and deletes require the table to have a primary key.

## Usage

Open the Database Viewer activity bar item, then choose one of:

- `Database Viewer: Open SQLite Database`
- `Database Viewer: Connect to PostgreSQL`

Click a table in the Databases tree to open it. Use the toolbar to refresh, add a row, filter rows, and move between pages.

## Settings

- `databaseViewer.defaultPageSize`: Default number of rows loaded per table page.

## Development

```bash
npm install
npm run compile
npm run lint
```

Press `F5` in VS Code to launch an Extension Development Host.

## Notes

SQLite files are edited in place. PostgreSQL passwords are only kept in memory for the current VS Code session.
