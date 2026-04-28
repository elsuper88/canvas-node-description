# Canvas Node Description

Obsidian plugin that adds a customizable **description badge above any canvas node**, plus a global toggle to show/hide all descriptions on the canvas.

Inspired by the `Start` badge from [Advanced Canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas), but applicable to any node with arbitrary text and color.

## Why

Swimlanes (group nodes) lock the layout into rigid rows. With descriptions you can label a node's role (e.g. *Cliente*, *Admin*, *Sistema*) and place it anywhere on the canvas — freeing up the layout while keeping the semantic role visible.

## Features

- **Per-node description** — pick a node, click the description button on the popup menu, type the label, choose color.
- **Inline color picker** — supports the canvas preset colors (1-6) and custom hex.
- **Global toggle** — a button on the canvas card menu (right-side toolbar) shows/hides every description on the active canvas.
- **Persisted in node data** — stored as `description` in the node JSON. Travels with the canvas file.
- **Settings tab** — default color, default position (top-right / top-left / top-center).

## Installation

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy them to `<vault>/.obsidian/plugins/canvas-node-description/`.
3. Reload Obsidian, enable the plugin in Settings → Community plugins.

### From source

```bash
git clone https://github.com/elsuper88/canvas-node-description.git
cd canvas-node-description
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, `styles.css` to your vault's plugins folder.

## Usage

1. Open a canvas (`.canvas` file).
2. Select any node — the popup menu appears (delete, color, edit…).
3. Click the new **tag** icon → modal opens.
4. Type the description and pick a color.
5. The badge appears above the node.

To hide every description on the active canvas, click the **eye** icon on the right-side card menu. Click again to show.

## Data format

Stored on the node JSON as a custom field:

```json
{
	"id": "abc123",
	"type": "text",
	"text": "Open the app",
	"description": {
		"text": "Cliente",
		"color": "4"
	}
}
```

This field is non-standard for the JSON Canvas spec but is preserved by Obsidian (any extra keys round-trip).

## Compatibility

- Obsidian 1.5+
- Works alongside Advanced Canvas (does not conflict with the `Start` badge — they coexist).

## License

MIT
