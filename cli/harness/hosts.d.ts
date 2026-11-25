// What the adapters use of the modules their harnesses provide. None is a package
// to depend on here: Pi's brings 22 others and Claude Code's is in no registry.
type Awaitable<T> = T | Promise<T>;

declare module "claude-code" {
  interface ToolUse {
    tool: string;
    input: Record<string, unknown>;
    text?: string;
    isError?: boolean;
  }
  type Piece = { stream: "stdout" | "stderr"; text: string };
  type Ended = { code: number | null; signal: string | null };

  export interface EngineInterface {
    command: {
      register(command: {
        name: string;
        description: string;
        argumentHint?: string;
        immediate?: boolean;
      }): Promise<void>;
    };
    process: {
      run(argv: string[]): Promise<unknown>;
      spawn(options: { argv: string[] }): AsyncIterator<Piece, Ended>;
    };
    prompt: { submit(prompt: { text: string; asUser: boolean }): Promise<{ drop?: string }> };
    session: {
      messages(range: { last: number }): Promise<{ toolUses: ToolUse[] }[] | { deny: unknown }>;
    };
    ui: { toast(text: string): void; status(text: string | undefined): void };
  }
  export type CommandRunResult = { text?: string; isTextDisplayOnly?: boolean };

  interface Events {
    "session.start": { isInteractive: boolean };
    "turn.start": { agentId?: string };
    "turn.complete": { agentId?: string };
    "command.describe": { isHidden?: boolean };
    "command.run": { args: string };
  }
  type Handler<E> = ($: EngineInterface, event: E, next: (event: E) => any) => any;
  type On = <K extends keyof Events>(
    event: K,
    ...rest: [Handler<Events[K]>] | [{ command: string }, Handler<Events[K]>]
  ) => void;
  export type Register = (on: On) => void;
}

declare module "@earendil-works/pi-coding-agent" {
  type Part =
    | { type: "text"; text: string }
    | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
  type Call = { status: string; name: string; arguments?: Record<string, unknown> };
  type Message =
    | { role: "user" }
    | { role: "assistant"; content: Part[] }
    | { role: "toolResult"; toolCallId: string; isError: boolean; nestedCalls?: { calls: Call[] } };
  type Entry = { type: "message"; message: Message } | { type: "custom" };

  export interface ExtensionCommandContext {
    cwd: string;
    hasUI: boolean;
    sessionManager: { getBranch(): Entry[] };
    ui: {
      notify(text: string, type: "info" | "warning" | "error"): void;
      setStatus(key: string, text: string | undefined): void;
    };
    waitForIdle(): Promise<void>;
  }
  export interface ExtensionAPI {
    on(event: "session_shutdown", handler: () => void): void;
    registerCommand(
      name: string,
      command: {
        description: string;
        handler: (typed: string, ctx: ExtensionCommandContext) => Awaitable<void>;
      },
    ): void;
    sendUserMessage(text: string, options: { deliverAs: "followUp" }): void;
  }
}

declare module "@opencode/plugin" {
  type Part =
    | { type: "text" }
    | { type: "tool"; name: string; state: { status: "completed"; input: Record<string, unknown> } };
  type Message =
    | { type: "user"; role: "user"; metadata?: Record<string, unknown> }
    | { type: "assistant"; role: "assistant"; content: Part[]; metadata?: Record<string, unknown> };
  type Session = { sessionID: string };

  interface Context {
    location: { directory: string };
    command: {
      transform(
        change: (commands: {
          add(command: {
            name: string;
            description: string;
            execute(call: Session & { prompt: { text: string } }): Promise<void>;
          }): void;
        }) => void,
      ): Promise<unknown>;
    };
    session: {
      context(session: Session): Promise<Message[]>;
      get(session: Session): Promise<{ location: { directory: string } }>;
      hook(name: "context", hook: (request: { messages: Message[] }) => Awaitable<void>): Promise<unknown>;
      prompt(prompt: Session & { text: string; delivery: "steer" | "queue" }): Promise<unknown>;
      synthetic(
        message: Session & { text: string; description: string; metadata: object; resume: boolean },
      ): Promise<unknown>;
      wait(session: Session): Promise<unknown>;
    };
  }
  export namespace Plugin {
    interface Plugin {
      setup(context: Context): Promise<() => void>;
    }
  }
}
