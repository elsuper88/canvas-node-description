import {
	App,
	Modal,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	setTooltip,
	WorkspaceLeaf,
} from "obsidian";

// =====================================================================
// Types — Obsidian's canvas internals are not public, so we describe the
// minimal shape we touch.
// =====================================================================

interface NodeDescription {
	text: string;
	color: string; // "1".."6" preset, or "#rrggbb"
	compact?: boolean; // if true, the node renders only its first heading
}

interface CanvasNodeMin {
	id: string;
	nodeEl: HTMLElement;
	getData(): Record<string, unknown> & { description?: NodeDescription };
	setData(data: Record<string, unknown>): void;
}

interface CanvasMenuMin {
	menuEl: HTMLElement;
}

interface CanvasMin {
	menu?: CanvasMenuMin;
	cardMenuEl?: HTMLElement;
	wrapperEl: HTMLElement;
	nodes: Map<string, CanvasNodeMin>;
	selection: Set<unknown>;
	requestSave?: () => void;
	requestPushHistory?: (data: unknown) => void;
}

interface CanvasViewMin {
	canvas?: CanvasMin;
}

// =====================================================================
// Settings
// =====================================================================

interface CndSettings {
	defaultColor: string;
	position: "top-right" | "top-left" | "top-center";
	hiddenByDefault: boolean;
}

const DEFAULT_SETTINGS: CndSettings = {
	defaultColor: "4",
	position: "top-right",
	hiddenByDefault: false,
};

// =====================================================================
// Plugin
// =====================================================================

export default class CanvasNodeDescriptionPlugin extends Plugin {
	settings: CndSettings = DEFAULT_SETTINGS;

	private attachedCanvases = new WeakSet<CanvasMin>();
	private menuObservers = new WeakMap<HTMLElement, MutationObserver>();

	async onload() {
		await this.loadSettings();

		this.app.workspace.onLayoutReady(() => this.scanLeaves());
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.scanLeaves()),
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () =>
				this.scanLeaves(),
			),
		);
		this.registerEvent(
			this.app.workspace.on("file-open", () => this.scanLeaves()),
		);

		this.addSettingTab(new CndSettingsTab(this.app, this));
	}

	onunload() {
		// Best-effort cleanup of decorations
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			const canvas = (leaf.view as unknown as CanvasViewMin).canvas;
			if (!canvas) continue;
			canvas.wrapperEl.classList.remove("cnd-hidden");
			canvas.cardMenuEl?.querySelector("#cnd-toggle-card")?.remove();
			canvas.menu?.menuEl?.querySelector("#cnd-popup-btn")?.remove();
			for (const [, node] of canvas.nodes) {
				node.nodeEl.removeAttribute("data-cnd-text");
				node.nodeEl.removeAttribute("data-cnd-color");
				node.nodeEl.removeAttribute("data-cnd-compact");
				node.nodeEl.style.removeProperty("--cnd-color");
			}
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// -----------------------------------------------------------------
	// Canvas attachment
	// -----------------------------------------------------------------

	private scanLeaves() {
		for (const leaf of this.app.workspace.getLeavesOfType("canvas")) {
			this.attachLeaf(leaf);
		}
	}

	private attachLeaf(leaf: WorkspaceLeaf) {
		const view = leaf.view as unknown as CanvasViewMin;
		const canvas = view.canvas;
		if (!canvas) return;
		if (this.attachedCanvases.has(canvas)) {
			// Re-render badges in case nodes were added since last attach.
			this.renderAll(canvas);
			this.injectCardMenuToggle(canvas);
			this.injectPopupButton(canvas);
			return;
		}
		this.attachedCanvases.add(canvas);

		if (this.settings.hiddenByDefault) {
			canvas.wrapperEl.classList.add("cnd-hidden");
		}

		this.applyPositionClass(canvas);
		this.injectCardMenuToggle(canvas);
		this.observePopupMenu(canvas);
		this.renderAll(canvas);
	}

	private applyPositionClass(canvas: CanvasMin) {
		const w = canvas.wrapperEl;
		w.classList.remove(
			"cnd-pos-top-right",
			"cnd-pos-top-left",
			"cnd-pos-top-center",
		);
		w.classList.add(`cnd-pos-${this.settings.position}`);
	}

	// -----------------------------------------------------------------
	// Card menu (right-side toolbar) — global toggle
	// -----------------------------------------------------------------

	private injectCardMenuToggle(canvas: CanvasMin) {
		const cardMenu = canvas.cardMenuEl;
		if (!cardMenu) return;
		const id = "cnd-toggle-card";
		cardMenu.querySelector(`#${id}`)?.remove();

		const btn = document.createElement("div");
		btn.id = id;
		btn.classList.add("canvas-card-menu-button", "mod-draggable");
		const updateIcon = () => {
			const hidden = canvas.wrapperEl.classList.contains("cnd-hidden");
			setIcon(btn, hidden ? "eye-off" : "eye");
			setTooltip(
				btn,
				hidden
					? "Show node descriptions"
					: "Hide node descriptions",
				{ placement: "left" },
			);
		};
		updateIcon();

		btn.addEventListener("click", () => {
			canvas.wrapperEl.classList.toggle("cnd-hidden");
			updateIcon();
		});

		cardMenu.appendChild(btn);
	}

	// -----------------------------------------------------------------
	// Popup menu (selected-node toolbar) — per-node description button
	// -----------------------------------------------------------------

	private observePopupMenu(canvas: CanvasMin) {
		const menuEl = canvas.menu?.menuEl;
		if (!menuEl) return;
		if (this.menuObservers.has(menuEl)) return;

		const obs = new MutationObserver(() =>
			this.injectPopupButton(canvas),
		);
		obs.observe(menuEl, { childList: true });
		this.menuObservers.set(menuEl, obs);
		this.register(() => obs.disconnect());

		this.injectPopupButton(canvas);
	}

	private injectPopupButton(canvas: CanvasMin) {
		const menuEl = canvas.menu?.menuEl;
		if (!menuEl) return;
		if (menuEl.querySelector("#cnd-popup-btn")) return;
		if (menuEl.children.length === 0) return;

		const btn = document.createElement("button");
		btn.id = "cnd-popup-btn";
		btn.classList.add("clickable-icon");
		setIcon(btn, "tag");
		setTooltip(btn, "Add or edit description", { placement: "top" });

		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const node = this.firstSelectedNode(canvas);
			if (!node) return;
			this.openModal(canvas, node);
		});

		menuEl.appendChild(btn);
	}

	// -----------------------------------------------------------------
	// Modal — edit description
	// -----------------------------------------------------------------

	private firstSelectedNode(canvas: CanvasMin): CanvasNodeMin | null {
		const sel = canvas.selection;
		if (!sel || typeof (sel as Set<unknown>).size !== "number") return null;
		for (const item of sel as Set<unknown>) {
			const candidate = item as Partial<CanvasNodeMin> & {
				path?: unknown;
			};
			// Edges have a .path property in Obsidian's canvas; nodes don't.
			if (candidate?.path !== undefined) continue;
			if (typeof candidate?.getData === "function") {
				return candidate as CanvasNodeMin;
			}
		}
		return null;
	}

	private openModal(canvas: CanvasMin, node: CanvasNodeMin) {
		if (!node || typeof node.getData !== "function") return;
		const current = node.getData().description;
		const modal = new DescriptionModal(
			this.app,
			current,
			this.settings,
			(next) => {
				const data = { ...node.getData() };
				if (next === null) {
					delete data.description;
				} else {
					data.description = next;
				}
				node.setData(data);
				this.applyToNode(node);
				canvas.requestSave?.();
			},
		);
		modal.open();
	}

	// -----------------------------------------------------------------
	// Render badges
	// -----------------------------------------------------------------

	private renderAll(canvas: CanvasMin) {
		for (const [, node] of canvas.nodes) {
			this.applyToNode(node);
		}
	}

	private applyToNode(node: CanvasNodeMin) {
		const desc = node.getData().description;
		const el = node.nodeEl;
		if (!desc || !desc.text) {
			el.removeAttribute("data-cnd-text");
			el.removeAttribute("data-cnd-color");
			el.removeAttribute("data-cnd-compact");
			el.style.removeProperty("--cnd-color");
			return;
		}
		el.setAttribute("data-cnd-text", desc.text);

		if (desc.color && desc.color.startsWith("#")) {
			el.style.setProperty("--cnd-color", desc.color);
			el.setAttribute("data-cnd-color", "custom");
		} else if (desc.color) {
			el.setAttribute("data-cnd-color", desc.color);
			el.style.removeProperty("--cnd-color");
		} else {
			el.removeAttribute("data-cnd-color");
			el.style.removeProperty("--cnd-color");
		}

		if (desc.compact) {
			el.setAttribute("data-cnd-compact", "true");
		} else {
			el.removeAttribute("data-cnd-compact");
		}
	}
}

// =====================================================================
// Modal
// =====================================================================

class DescriptionModal extends Modal {
	private desc: NodeDescription;
	private settings: CndSettings;
	private onSave: (next: NodeDescription | null) => void;

	constructor(
		app: App,
		current: NodeDescription | undefined,
		settings: CndSettings,
		onSave: (next: NodeDescription | null) => void,
	) {
		super(app);
		this.desc = current
			? { ...current }
			: { text: "", color: settings.defaultColor };
		this.settings = settings;
		this.onSave = onSave;
	}

	onOpen() {
		this.draw();
	}

	onClose() {
		this.contentEl.empty();
	}

	private previewEl: HTMLElement | null = null;
	private swatchesEl: HTMLElement | null = null;
	private hexInputEl: HTMLInputElement | null = null;
	private hexRowEl: HTMLElement | null = null;

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cnd-modal");

		contentEl.createEl("h3", { text: "Node description" });

		// --- Live preview badge ---
		const previewWrap = contentEl.createDiv({ cls: "cnd-preview-wrap" });
		previewWrap.createEl("span", {
			text: "Preview",
			cls: "cnd-preview-label",
		});
		this.previewEl = previewWrap.createEl("span", {
			cls: "cnd-preview-badge",
		});
		this.updatePreview();

		// --- Text input ---
		const textRow = contentEl.createDiv({ cls: "cnd-row" });
		textRow.createEl("label", {
			text: "Text",
			cls: "cnd-row-label",
			attr: { for: "cnd-text-input" },
		});
		const textInput = textRow.createEl("input", {
			cls: "cnd-text-input",
			attr: {
				id: "cnd-text-input",
				type: "text",
				placeholder: "e.g. Cliente, Admin, Sistema",
				value: this.desc.text,
			},
		});
		textInput.addEventListener("input", () => {
			this.desc.text = textInput.value;
			this.updatePreview();
		});
		textInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitSave();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});
		setTimeout(() => textInput.focus(), 50);

		// --- Color swatches ---
		const colorRow = contentEl.createDiv({ cls: "cnd-row" });
		colorRow.createEl("label", { text: "Color", cls: "cnd-row-label" });
		this.swatchesEl = colorRow.createDiv({ cls: "cnd-swatches" });

		const presets: { key: string; name: string }[] = [
			{ key: "1", name: "Red" },
			{ key: "2", name: "Orange" },
			{ key: "3", name: "Yellow" },
			{ key: "4", name: "Green" },
			{ key: "5", name: "Cyan" },
			{ key: "6", name: "Purple" },
		];

		for (const p of presets) {
			const sw = this.swatchesEl.createEl("button", {
				cls: "cnd-swatch",
				attr: { type: "button", "data-color": p.key, "aria-label": p.name },
			});
			setTooltip(sw, p.name, { placement: "top" });
			sw.addEventListener("click", () => this.selectColor(p.key));
		}

		const customSwatch = this.swatchesEl.createEl("button", {
			cls: "cnd-swatch cnd-swatch-custom",
			attr: { type: "button", "data-color": "custom", "aria-label": "Custom hex" },
		});
		setTooltip(customSwatch, "Custom hex", { placement: "top" });
		customSwatch.createSpan({ text: "+" });
		customSwatch.addEventListener("click", () => {
			if (!this.desc.color.startsWith("#")) {
				this.desc.color = "#7f6df2";
			}
			this.refreshSwatchActive();
			this.refreshHexRow();
			this.updatePreview();
			this.hexInputEl?.focus();
		});

		// --- Hex input row (only when custom) ---
		this.hexRowEl = contentEl.createDiv({ cls: "cnd-row cnd-hex-row" });
		this.hexRowEl.createEl("label", { text: "Hex", cls: "cnd-row-label" });
		const hexWrap = this.hexRowEl.createDiv({ cls: "cnd-hex-wrap" });

		const colorPicker = hexWrap.createEl("input", {
			cls: "cnd-color-picker",
			attr: { type: "color" },
		});
		this.hexInputEl = hexWrap.createEl("input", {
			cls: "cnd-hex-input",
			attr: { type: "text", placeholder: "#7f6df2" },
		});

		const syncHexFromPicker = () => {
			this.desc.color = colorPicker.value;
			if (this.hexInputEl) this.hexInputEl.value = colorPicker.value;
			this.refreshSwatchActive();
			this.updatePreview();
		};
		const syncHexFromInput = () => {
			if (!this.hexInputEl) return;
			const v = this.hexInputEl.value.trim();
			this.desc.color = v;
			if (/^#[0-9a-fA-F]{6}$/.test(v)) colorPicker.value = v;
			this.refreshSwatchActive();
			this.updatePreview();
		};
		colorPicker.addEventListener("input", syncHexFromPicker);
		this.hexInputEl.addEventListener("input", syncHexFromInput);
		this.hexInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.commitSave();
			}
		});

		this.refreshSwatchActive();
		this.refreshHexRow();

		// --- Compact toggle ---
		const compactRow = contentEl.createDiv({ cls: "cnd-row cnd-compact-row" });
		const compactLabel = compactRow.createEl("label", {
			cls: "cnd-compact-toggle",
			attr: { for: "cnd-compact-input" },
		});
		const compactInput = compactLabel.createEl("input", {
			attr: {
				id: "cnd-compact-input",
				type: "checkbox",
			},
		}) as HTMLInputElement;
		compactInput.checked = !!this.desc.compact;
		compactLabel.createSpan({
			text: "Compact (show only first heading, double-click opens the note)",
			cls: "cnd-compact-text",
		});
		compactInput.addEventListener("change", () => {
			this.desc.compact = compactInput.checked;
		});

		// --- Footer buttons ---
		const footer = contentEl.createDiv({ cls: "cnd-footer" });
		const removeBtn = footer.createEl("button", {
			cls: "mod-warning cnd-btn cnd-btn-remove",
			text: "Remove",
		});
		removeBtn.addEventListener("click", () => {
			this.onSave(null);
			this.close();
		});

		const cancelBtn = footer.createEl("button", {
			cls: "cnd-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => this.close());

		const saveBtn = footer.createEl("button", {
			cls: "mod-cta cnd-btn cnd-btn-save",
			text: "Save",
		});
		saveBtn.addEventListener("click", () => this.commitSave());
	}

	private selectColor(key: string) {
		this.desc.color = key;
		this.refreshSwatchActive();
		this.refreshHexRow();
		this.updatePreview();
	}

	private commitSave() {
		if (!this.desc.text.trim()) {
			this.onSave(null);
		} else {
			this.onSave({
				text: this.desc.text.trim(),
				color: this.desc.color || this.settings.defaultColor,
				compact: this.desc.compact || undefined,
			});
		}
		this.close();
	}

	private isCustomColor() {
		return this.desc.color.startsWith("#");
	}

	private refreshSwatchActive() {
		if (!this.swatchesEl) return;
		const activeKey = this.isCustomColor() ? "custom" : this.desc.color;
		this.swatchesEl
			.querySelectorAll(".cnd-swatch")
			.forEach((el) => {
				const key = (el as HTMLElement).dataset.color;
				el.toggleClass("is-active", key === activeKey);
			});
		const customEl = this.swatchesEl.querySelector(
			".cnd-swatch-custom",
		) as HTMLElement | null;
		if (customEl && this.isCustomColor()) {
			customEl.style.setProperty("--cnd-swatch-color", this.desc.color);
		}
	}

	private refreshHexRow() {
		if (!this.hexRowEl || !this.hexInputEl) return;
		if (this.isCustomColor()) {
			this.hexRowEl.removeClass("is-hidden");
			this.hexInputEl.value = this.desc.color;
		} else {
			this.hexRowEl.addClass("is-hidden");
		}
	}

	private updatePreview() {
		if (!this.previewEl) return;
		const text = this.desc.text.trim() || "Preview";
		this.previewEl.textContent = text;
		this.previewEl.toggleClass("is-empty", !this.desc.text.trim());

		// Reset preset classes
		for (let i = 1; i <= 6; i++) {
			this.previewEl.removeAttribute(`data-color-${i}`);
		}
		this.previewEl.removeAttribute("data-color");
		this.previewEl.style.removeProperty("--cnd-color");

		if (this.isCustomColor()) {
			this.previewEl.setAttribute("data-color", "custom");
			this.previewEl.style.setProperty("--cnd-color", this.desc.color);
		} else {
			this.previewEl.setAttribute("data-color", this.desc.color);
		}
	}
}

// =====================================================================
// Settings tab
// =====================================================================

class CndSettingsTab extends PluginSettingTab {
	plugin: CanvasNodeDescriptionPlugin;

	constructor(app: App, plugin: CanvasNodeDescriptionPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default color")
			.setDesc("Used when adding a description for the first time")
			.addDropdown((d) =>
				d
					.addOption("1", "Red")
					.addOption("2", "Orange")
					.addOption("3", "Yellow")
					.addOption("4", "Green")
					.addOption("5", "Cyan")
					.addOption("6", "Purple")
					.setValue(this.plugin.settings.defaultColor)
					.onChange(async (v) => {
						this.plugin.settings.defaultColor = v;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Badge position")
			.setDesc("Where the description appears relative to the node")
			.addDropdown((d) =>
				d
					.addOption("top-right", "Top right")
					.addOption("top-left", "Top left")
					.addOption("top-center", "Top center")
					.setValue(this.plugin.settings.position)
					.onChange(async (v) => {
						this.plugin.settings.position =
							v as CndSettings["position"];
						await this.plugin.saveSettings();
						// Re-apply class on every open canvas
						for (const leaf of this.app.workspace.getLeavesOfType(
							"canvas",
						)) {
							const canvas = (leaf.view as unknown as CanvasViewMin)
								.canvas;
							if (!canvas) continue;
							canvas.wrapperEl.classList.remove(
								"cnd-pos-top-right",
								"cnd-pos-top-left",
								"cnd-pos-top-center",
							);
							canvas.wrapperEl.classList.add(`cnd-pos-${v}`);
						}
					}),
			);

		new Setting(containerEl)
			.setName("Hide descriptions by default")
			.setDesc("Open canvases with descriptions hidden")
			.addToggle((t) =>
				t
					.setValue(this.plugin.settings.hiddenByDefault)
					.onChange(async (v) => {
						this.plugin.settings.hiddenByDefault = v;
						await this.plugin.saveSettings();
					}),
			);
	}
}
