// fx speaks the Agent Client Protocol, so BB's shared ACP bridge is the whole
// implementation: this plugin contributes the launch spec (server.ts) and
// re-exports the bridge under the export name the host loads.
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
