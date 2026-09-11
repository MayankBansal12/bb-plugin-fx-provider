import { fileURLToPath } from "node:url";
import {
  experimental_acpLaunchSpecSchema,
  experimental_acpProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge/acp";
import { runFxAcp } from "./src/fx-acp.js";

const adapterFlag = "--fx-acp-adapter";
const modulePath = fileURLToPath(import.meta.url);

// BB normally imports this artifact. Only a direct invocation by the shared
// bridge starts the adapter, using the same self-contained artifact on each host.
if (process.argv[1] === modulePath && process.argv[2] === adapterFlag) {
  const command = process.argv[3];
  if (!command) throw new Error("Missing fx ACP command");
  runFxAcp(command, process.argv.slice(4));
}

export const experimental_providerBridge = {
  ...experimental_acpProviderBridge,
  handleLine(line: string): void {
    try {
      const message = JSON.parse(line);
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
