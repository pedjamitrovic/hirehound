import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { configDir, loadAppConfig, resolveWorkspace, type WorkspaceSource } from "./config.ts";
import { DiscoveryService, summarize } from "./discovery/service.ts";
import { JobService } from "./jobs/service.ts";
import { fetchPosting } from "./jobs/snapshot.ts";
import { openExternal } from "./open.ts";
import { PdfRenderer } from "./pdf/render.ts";
import { ProfileService } from "./profile/service.ts";
import { DEFAULT_PORT, startServer } from "./server.ts";
import { TaskRunner } from "./tasks.ts";
import { APP_VERSION } from "./version.ts";
import { WorkspaceIndex } from "./workspace/index.ts";
import { initWorkspace, inspectWorkspace } from "./workspace/init.ts";

const HELP = `Hirehound ${APP_VERSION}: local-first job search workbench

Usage:
  hirehound [serve] [options]   Start the app and open it in the browser
  hirehound init [path]         Create a workspace (never overwrites files)
  hirehound scan [options]      Scan the job boards in sources/portals.yaml once and exit
                                (for cron or Task Scheduler; the app also scans while open)

Options:
  -w, --workspace <path>  Workspace folder. Default: HIREHOUND_WORKSPACE, then
                          ~/.config/hirehound/config.yaml, then ~/Documents/hirehound
  -p, --port <number>     Port (default ${DEFAULT_PORT}; tries the next ones if taken)
      --no-open           Do not open the browser
      --dev               Development: serve the UI through Vite with live reload
  -h, --help              Show this help
  -v, --version           Show the version
`;

const SOURCE_LABEL: Record<WorkspaceSource, string> = {
  flag: "--workspace",
  env: "HIREHOUND_WORKSPACE",
  config: "config.yaml",
  default: "default location",
};

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (values.version) {
    console.log(APP_VERSION);
    return 0;
  }

  const [command = "serve", target] = positionals;
  const config = loadAppConfig();
  const resolveTarget = () =>
    resolveWorkspace({
      flag: values.workspace,
      env: process.env,
      home: homedir(),
      cwd: process.cwd(),
      config,
      configDir: configDir(),
    });

  if (command === "init") {
    const path = target ? resolve(target) : resolveTarget().path;
    const { created } = await initWorkspace(path);
    console.log(
      created.length
        ? `Workspace ready at ${path}\nCreated: ${created.join(", ")}`
        : `Workspace at ${path} is already set up; nothing changed.`,
    );
    return 0;
  }

  if (command === "scan") {
    const workspace = resolveTarget();
    if ((await inspectWorkspace(workspace.path)) !== "workspace") {
      console.error(`${workspace.path} is not a Hirehound workspace.`);
      return 1;
    }
    return runScan(workspace.path);
  }

  if (command !== "serve") {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    return 2;
  }

  const workspace = resolveTarget();
  const kind = await inspectWorkspace(workspace.path);
  if (kind === "other") {
    console.error(
      `${workspace.path} exists but is not a Hirehound workspace.\n` +
        `Run "hirehound init ${workspace.path}" to turn it into one, or choose another folder with --workspace.`,
    );
    return 1;
  }
  if (kind === "missing" || kind === "empty") {
    await initWorkspace(workspace.path);
    console.log(`Created a new workspace at ${workspace.path}`);
  }

  const explicitPort = values.port !== undefined;
  const port = explicitPort ? Number(values.port) : (config.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${values.port}`);
    return 2;
  }
  const dev = values.dev ?? false;
  const server = await startServer({
    workspace: workspace.path,
    port,
    strictPort: explicitPort,
    dev,
  });

  console.log(
    `Hirehound ${APP_VERSION} running at ${server.url}\n` +
      `Workspace: ${workspace.path} (${SOURCE_LABEL[workspace.source]})\n` +
      "Press Ctrl+C to stop.",
  );
  // In dev, `node --watch` restarts the server on every change; do not open a tab each time.
  if (values.open ?? !dev) openExternal(server.url);

  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
  return 0;
}

/** One scan of every enabled portal, without starting the server. */
async function runScan(root: string): Promise<number> {
  const index = new WorkspaceIndex(root);
  await index.load();
  const pdf = new PdfRenderer();
  const discovery = new DiscoveryService({
    root,
    index,
    jobs: new JobService({ root, index }),
    profile: new ProfileService({ root, pdf }),
    tasks: new TaskRunner(),
    fetchPosting: (url) => fetchPosting(url),
  });
  try {
    const entries = await discovery.scan("cli", undefined, (message) => console.log(message));
    const s = summarize(entries);
    console.log(
      `Added ${s.added}, filtered ${s.filtered}, already known ${s.duplicates}, no longer listed ${s.gone} (${s.expired} expired).`,
    );
    for (const f of s.failed) console.error(`${f.source}: ${f.error}`);
    return s.failed.length ? 1 : 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  } finally {
    await pdf.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      workspace: { type: "string", short: "w" },
      port: { type: "string", short: "p" },
      open: { type: "boolean" },
      dev: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
