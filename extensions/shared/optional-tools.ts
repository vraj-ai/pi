/**
 * Registry of tools that are registered but not always offered to the model.
 *
 * Every registered tool costs context on every turn: its name, description,
 * parameter schema, and prompt guidelines are all in the system prompt whether
 * or not the model ever calls it. Three of this package's tools are rarely
 * needed in a given session, so they default to off and are switched on from
 * `/features` (or automatically, when something makes them relevant).
 *
 * The mechanism is `pi.setActiveTools`, which is the only lever that actually
 * removes a tool from the prompt. Registration still happens at load time so a
 * tool can be enabled mid-session without a reload.
 *
 * Extensions declare their optional tools here; `session-tools` owns `/features`
 * and drives the toggling. A plain module singleton is enough: every extension
 * resolves this file to the same module instance inside one pi process.
 */

export type ToolState = "on" | "off";

export interface OptionalTool {
  readonly name: string;
  /** Shown by `/features`. */
  readonly summary: string;
  /**
   * Whether the tool is offered when lean mode is on. `false` means it costs
   * context only once someone asks for it.
   */
  readonly leanDefault: ToolState;
  /**
   * Why it is safe to leave off. Surfaced by `/features` so the trade-off is
   * visible rather than a silent omission.
   */
  readonly rationale: string;
}

export interface ToolRegistryHost {
  getActiveTools(): string[];
  getAllTools(): Array<{ name: string }>;
  setActiveTools(names: string[]): void;
}

/**
 * Owns which optional tools are currently offered and reconciles that against
 * pi's active-tool set.
 */
export class OptionalToolRegistry {
  readonly #tools = new Map<string, OptionalTool>();
  readonly #state = new Map<string, ToolState>();
  readonly #explicit = new Set<string>();
  #lean = true;
  #host: ToolRegistryHost | undefined;

  /** Declare an optional tool. Idempotent, so a reload cannot double-register. */
  register(tool: OptionalTool) {
    this.#tools.set(tool.name, tool);
    if (!this.#state.has(tool.name)) {
      this.#state.set(tool.name, this.#lean ? tool.leanDefault : "on");
    }
    this.apply();
  }

  /** Bind the pi API. Until this is called, toggles are recorded but not applied. */
  bind(host: ToolRegistryHost) {
    this.#host = host;
    this.apply();
  }

  unbind() {
    this.#host = undefined;
  }

  get lean() {
    return this.#lean;
  }

  /**
   * Lean mode drives the *defaults*. Switching it re-derives every tool that
   * has not been explicitly toggled this session; an explicit choice is kept,
   * because silently undoing what someone just asked for is worse than a
   * slightly larger prompt.
   */
  setLean(lean: boolean) {
    this.#lean = lean;
    for (const [name, tool] of this.#tools) {
      if (this.#explicit.has(name)) continue;
      this.#state.set(name, lean ? tool.leanDefault : "on");
    }
    this.apply();
  }

  set(name: string, state: ToolState) {
    if (!this.#tools.has(name)) return false;
    this.#state.set(name, state);
    this.#explicit.add(name);
    this.apply();
    return true;
  }

  /**
   * Turn a tool on because it just became useful (the first compressed output,
   * for example). Never overrides an explicit `off`: an automatic enable must
   * not undo a deliberate choice.
   */
  enableOnDemand(name: string) {
    if (!this.#tools.has(name)) return false;
    if (this.#explicit.has(name) && this.#state.get(name) === "off")
      return false;
    if (this.#state.get(name) === "on") return false;
    this.#state.set(name, "on");
    this.apply();
    return true;
  }

  stateOf(name: string): ToolState | undefined {
    return this.#state.get(name);
  }

  list(): Array<{ tool: OptionalTool; state: ToolState }> {
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tool) => ({ tool, state: this.#state.get(tool.name) ?? "off" }));
  }

  /** Tool names currently withheld from the model. */
  disabledNames() {
    return [...this.#tools.keys()].filter(
      (name) => this.#state.get(name) === "off",
    );
  }

  /**
   * Reconcile pi's active-tool set: everything configured, minus the optional
   * tools currently off. Recomputed from `getAllTools()` each time so a tool
   * another extension registers later is not dropped.
   */
  apply() {
    const host = this.#host;
    if (!host) return;
    let all: string[];
    try {
      all = host.getAllTools().map((tool) => tool.name);
    } catch {
      return;
    }
    const off = new Set(this.disabledNames());
    const next = all.filter((name) => !off.has(name));
    try {
      const current = host.getActiveTools();
      // Avoid a pointless refresh when nothing moved.
      if (
        current.length === next.length &&
        next.every((name) => current.includes(name))
      ) {
        return;
      }
      host.setActiveTools(next);
    } catch {
      // A host that cannot toggle tools simply keeps them all; the tools still
      // work, they just cost context.
    }
  }

  /** Test seam. */
  reset() {
    this.#tools.clear();
    this.#state.clear();
    this.#explicit.clear();
    this.#lean = true;
    this.#host = undefined;
  }
}

/** The process-wide registry every extension shares. */
export const optionalTools = new OptionalToolRegistry();

/** Read `vraj.tools.lean` from the agent settings; defaults to lean. */
export function readLeanSetting(settings: Record<string, unknown>) {
  const value = settings["vraj.tools.lean"];
  return typeof value === "boolean" ? value : true;
}
