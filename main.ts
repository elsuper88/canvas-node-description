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

	private draw() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Node description" });

		new Setting(contentEl)
			.setName("Text")
			.setDesc("Label shown above the node")
			.addText((t) =>
				t
					.setPlaceholder("e.g. Cliente, Admin, Sistema")
					.setValue(this.desc.text)
					.onChange((v) => {
						this.desc.text = v;
					}),
			);

		const isCustom = this.desc.color.startsWith("#");

		new Setting(contentEl)
			.setName("Color")
			.setDesc("Preset or custom hex")
			.addDropdown((d) =>
				d
					.addOption("1", "Red")
					.addOption("2", "Orange")
					.addOption("3", "Yellow")
					.addOption("4", "Green")
					.addOption("5", "Cyan")
					.addOption("6", "Purple")
					.addOption("custom", "Custom hex…")
					.setValue(isCustom ? "custom" : this.desc.color)
					.onChange((v) => {
						if (v === "custom") {
							if (!this.desc.color.startsWith("#"))
								this.desc.color = "#7f6df2";
						} else {
							this.desc.color = v;
						}
						this.draw();
					}),
			);

		if (isCustom) {
			new Setting(contentEl)
				.setName("Custom hex")
				.addText((t) =>
					t
						.setPlaceholder("#7f6df2")
						.setValue(this.desc.color)
						.onChange((v) => {
							this.desc.color = v.trim();
						}),
				);
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.onSave(null);
						this.close();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						if (!this.desc.text.trim()) {
							this.onSave(null);
						} else {
							this.onSave({
								text: this.desc.text.trim(),
								color: this.desc.color || this.settings.defaultColor,
							});
						}
						this.close();
					}),
			);
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
