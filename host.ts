import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createFxModelCatalogProxy } from "./src/model-catalog.js";
import {
  experimental_acpLaunchSpecSchema,
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { runFxAcp } from "./src/fx-acp.js";

const adapterFlag = "--fx-acp-adapter";
const modulePath = fileURLToPath(import.meta.url);
const modelCatalogFlag = "--fx-model-catalog";
const modelCatalogMode =
  process.argv[1] === modulePath && process.argv[2] === modelCatalogFlag;
const modelCatalog = createFxModelCatalogProxy(modulePath, modelCatalogFlag);

// BB normally imports this artifact. Only a direct invocation by the shared
// bridge starts the adapter, using the same self-contained artifact on each host.
if (process.argv[1] === modulePath && process.argv[2] === adapterFlag) {
  const command = process.argv[3];
  if (!command) throw new Error("Missing fx ACP command");
  runFxAcp(command, process.argv.slice(4));
}

let closing = false;
function closeBridge(): void {
  if (closing) return;
  closing = true;
  modelCatalog.close();
  experimental_acpProviderBridge.onClose?.();
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  // The SDK bootstrap only hooks signals declared by the entry. Signals and
  // stdin closure must all release detached model probes before the SDK exits.
  onClose: closeBridge,
  onSigterm: closeBridge,
  onSigint: closeBridge,
  handleLine(line: string): void {
    try {
      const message = JSON.parse(line);
      if (
        !modelCatalogMode &&
        message.method === "model/list" &&
        (typeof message.id === "string" || typeof message.id === "number")
      ) {
        modelCatalog.request(line, message.id);
        return;
      }
      // Health probes should inspect the actual fx executable. Model discovery
      // and session construction need the config-option compatibility adapter.
      if (
        [
          "model/list",
          "thread/start",
          "thread/resume",
          "thread/fork",
          "turn/start",
        ].includes(message.method)
      ) {
        const options =
          message.params?.options?.providerOptions ??
          message.params?.providerOptions;
        const spec = experimental_acpLaunchSpecSchema.safeParse(
          options?.acpLaunchSpec,
        );
        if (spec.success) {
          options.acpLaunchSpec = {
            ...spec.data,
            command: process.execPath,
            args: [
              modulePath,
              adapterFlag,
              spec.data.command,
              ...spec.data.args,
            ],
          };
          line = JSON.stringify(message);
        }
      }
    } catch {
      // The shared bridge owns invalid JSON and request validation.
    }
    experimental_acpProviderBridge.handleLine(line);
  },
};

// A short-lived model probe uses the same shared bridge and ACP adapter. Its
// stdout is isolated so catalog metadata can be normalized without patching
// SDK internals or intercepting the main bridge's session/approval traffic.
if (modelCatalogMode) {
  createInterface({ input: process.stdin })
    .on("line", (line) => experimental_providerBridge.handleLine(line))
    .on("close", () => experimental_providerBridge.onClose());
}
